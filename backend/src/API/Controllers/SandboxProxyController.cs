namespace DevPilot.API.Controllers;

using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Claims;
using DevPilot.Infrastructure.Sandbox;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Reverse-proxy all sandbox bridge and VNC traffic through the backend.
/// The browser never receives internal sandbox URLs — it only uses relative
/// paths like <c>/api/sandboxes/{id}/bridge/health</c> or
/// <c>/api/sandboxes/{id}/vnc/vnc_lite.html</c>.
/// </summary>
[ApiController]
[Route("api/sandboxes/{sandboxId}")]
[Authorize]
public class SandboxProxyController : ControllerBase
{
    private readonly SandboxService _sandboxService;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<SandboxProxyController> _logger;

    public SandboxProxyController(
        SandboxService sandboxService,
        IHttpClientFactory httpClientFactory,
        ILogger<SandboxProxyController> logger)
    {
        _sandboxService = sandboxService;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    // ── Bridge HTTP proxy ────────────────────────────────────────────────────

    [HttpGet("bridge/{**subpath}")]
    [HttpPost("bridge/{**subpath}")]
    [HttpPut("bridge/{**subpath}")]
    [HttpDelete("bridge/{**subpath}")]
    [HttpPatch("bridge/{**subpath}")]
    public async Task<IActionResult> ProxyBridge(string sandboxId, string? subpath)
    {
        var info = await ResolveInfoAsync(sandboxId);
        if (info is null) return NotFound(new { error = "Sandbox not found" });

        var target = BuildUpstreamUrl(info.InternalBridgeUrl, subpath, Request.QueryString.Value);
        return await ForwardHttpAsync(target, info.SandboxToken);
    }

    // ── VNC HTTP proxy (noVNC static files) ──────────────────────────────────
    // AllowAnonymous: the noVNC iframe cannot carry a JWT.
    // Access is gated by the sandbox ID (random UUID).

    [AllowAnonymous]
    [HttpGet("vnc/{**subpath}")]
    public async Task<IActionResult> ProxyVnc(string sandboxId, string? subpath)
    {
        var info = await _sandboxService.TryGetOrRediscoverByIdAsync(sandboxId, HttpContext.RequestAborted);
        if (info is null) return NotFound(new { error = "Sandbox not found" });

        var vncBase = ExtractVncBasePath(info.InternalVncUrl);
        var target = BuildUpstreamUrl(vncBase, subpath, Request.QueryString.Value);
        return await ForwardHttpAsync(target, sandboxToken: null);
    }

    // ── VNC WebSocket proxy ──────────────────────────────────────────────────

    [AllowAnonymous]
    [Route("vnc/websockify")]
    public async Task ProxyVncWebSocket(string sandboxId)
    {
        if (!HttpContext.WebSockets.IsWebSocketRequest)
        {
            HttpContext.Response.StatusCode = 400;
            await HttpContext.Response.WriteAsync("WebSocket upgrade required");
            return;
        }

        var info = await _sandboxService.TryGetOrRediscoverByIdAsync(sandboxId, HttpContext.RequestAborted);
        if (info is null)
        {
            HttpContext.Response.StatusCode = 404;
            await HttpContext.Response.WriteAsync("Sandbox not found");
            return;
        }

        var vncBase = ExtractVncBasePath(info.InternalVncUrl);
        var httpUri = new Uri(vncBase, UriKind.Absolute);
        var wsScheme = httpUri.Scheme == "https" ? "wss" : "ws";
        var wsUri = new Uri($"{wsScheme}://{httpUri.Authority}{httpUri.AbsolutePath.TrimEnd('/')}/websockify");

        _logger.LogInformation("VNC WebSocket proxy connecting to {Uri}", wsUri);

        using var downstream = await HttpContext.WebSockets.AcceptWebSocketAsync();
        using var upstream = new ClientWebSocket();
        upstream.Options.KeepAliveInterval = TimeSpan.FromSeconds(25);

        try
        {
            await upstream.ConnectAsync(wsUri, HttpContext.RequestAborted);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Cannot connect to upstream VNC WebSocket at {Uri}", wsUri);
            await downstream.CloseAsync(WebSocketCloseStatus.EndpointUnavailable, "Upstream VNC unreachable", default);
            return;
        }

        var cts = CancellationTokenSource.CreateLinkedTokenSource(HttpContext.RequestAborted);

        var upToDown = PipeAsync(upstream, downstream, cts);
        var downToUp = PipeAsync(downstream, upstream, cts);

        await Task.WhenAny(upToDown, downToUp);
        cts.Cancel();

        await CloseGracefully(upstream);
        await CloseGracefully(downstream);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private async Task<SandboxInternalInfo?> ResolveInfoAsync(string sandboxId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty) return null;

        var info = _sandboxService.TryGetInternalInfo(userId, sandboxId);
        if (info is not null) return info;

        return await _sandboxService.TryRediscoverAsync(userId, sandboxId, HttpContext.RequestAborted);
    }

    private Guid GetUserId()
    {
        var raw = User.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(raw, out var id) ? id : Guid.Empty;
    }

    private async Task<byte[]> ReadBodyAsync()
    {
        using var ms = new MemoryStream();
        await Request.Body.CopyToAsync(ms, HttpContext.RequestAborted);
        return ms.ToArray();
    }

    private static string BuildUpstreamUrl(string baseUrl, string? subpath, string? queryString)
    {
        var url = baseUrl.TrimEnd('/');
        if (!string.IsNullOrEmpty(subpath))
            url += "/" + subpath;
        if (!string.IsNullOrEmpty(queryString))
            url += queryString;
        return url;
    }

    /// <summary>
    /// Extract the VNC base path from the full internal VNC URL.
    /// e.g. <c>http://localhost:8090/sandbox/{id}/vnc/vnc_lite.html?…</c>
    ///   → <c>http://localhost:8090/sandbox/{id}/vnc</c>
    /// The manager serves noVNC files under this directory.
    /// </summary>
    private static string ExtractVncBasePath(string fullVncUrl)
    {
        try
        {
            var uri = new Uri(fullVncUrl, UriKind.Absolute);
            var path = uri.AbsolutePath;
            var lastSlash = path.LastIndexOf('/');
            var dirPath = lastSlash > 0 ? path[..lastSlash] : path;
            return $"{uri.Scheme}://{uri.Authority}{dirPath}";
        }
        catch
        {
            return fullVncUrl;
        }
    }

    private async Task<IActionResult> ForwardHttpAsync(string targetUrl, string? sandboxToken)
    {
        var client = _httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(120);

        var method = new HttpMethod(Request.Method);
        using var req = new HttpRequestMessage(method, targetUrl);

        if (!string.IsNullOrEmpty(sandboxToken))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", sandboxToken);

        if (Request.ContentLength > 0 || Request.ContentType is not null)
        {
            var bodyBytes = await ReadBodyAsync();
            req.Content = new ByteArrayContent(bodyBytes);
            if (Request.ContentType is not null)
                req.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(Request.ContentType);
        }

        HttpResponseMessage upstream;
        try
        {
            upstream = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, HttpContext.RequestAborted);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Proxy request to {Url} failed", targetUrl);
            return StatusCode(502, new { error = "Upstream unreachable" });
        }

        Response.StatusCode = (int)upstream.StatusCode;

        foreach (var header in upstream.Content.Headers)
            Response.Headers[header.Key] = header.Value.ToArray();
        foreach (var header in upstream.Headers)
        {
            if (header.Key.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase)) continue;
            Response.Headers[header.Key] = header.Value.ToArray();
        }

        await upstream.Content.CopyToAsync(Response.Body, HttpContext.RequestAborted);
        return new EmptyResult();
    }

    private static async Task PipeAsync(WebSocket from, WebSocket to, CancellationTokenSource cts)
    {
        var buf = new byte[16 * 1024];
        try
        {
            while (!cts.Token.IsCancellationRequested)
            {
                var result = await from.ReceiveAsync(new ArraySegment<byte>(buf), cts.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                    break;
                await to.SendAsync(new ArraySegment<byte>(buf, 0, result.Count), result.MessageType, result.EndOfMessage, cts.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
    }

    private static async Task CloseGracefully(WebSocket ws)
    {
        try
        {
            if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
        }
        catch { }
    }
}
