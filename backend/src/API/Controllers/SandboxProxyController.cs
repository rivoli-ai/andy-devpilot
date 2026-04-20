namespace DevPilot.API.Controllers;

using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Claims;
using System.Text;
using System.Text.RegularExpressions;
using DevPilot.Domain.Interfaces;
using DevPilot.Infrastructure.Sandbox;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;

/// <summary>
/// Reverse-proxy all sandbox bridge, VNC, and dev-server preview traffic through the backend.
/// The browser never receives internal sandbox URLs — it only uses relative
/// paths like <c>/api/sandboxes/{id}/bridge/health</c>,
/// <c>/api/sandboxes/{id}/vnc/vnc_lite.html</c>, or
/// <c>/api/sandboxes/{id}/preview/5173/</c> for in-sandbox dev servers.
/// Preview and VNC are <see cref="AllowAnonymousAttribute"/> (iframes cannot send JWT); bridge stays authorized.
/// </summary>
[ApiController]
[Route("api/sandboxes/{sandboxId}")]
public class SandboxProxyController : ControllerBase
{
    /// <summary>
    /// SSRF guard: anything not in this list (and within the valid TCP range) is allowed
    /// so users can preview dev servers on arbitrary ports. Must stay in sync with
    /// <c>DENIED_PREVIEW_PORTS</c> in <c>infra/sandbox/manager/manager.py</c>.
    /// </summary>
    private static readonly HashSet<int> DeniedPreviewPorts = new()
    {
        0,
        22,           // ssh
        25,           // smtp
        111,          // rpcbind
        135, 139, 445,// windows rpc / smb
        389, 636,     // ldap
        1433,         // mssql
        3306,         // mysql
        5432,         // postgres
        5900,         // VNC raw
        6379,         // redis
        6080, 6081,   // noVNC (sandbox)
        8090,         // sandbox manager itself
        8091,         // sandbox bridge
        9042,         // cassandra
        11211,        // memcached
        27017,        // mongodb
    };

    private static bool IsPreviewPortAllowed(int port) =>
        port is >= 1 and <= 65535 && !DeniedPreviewPorts.Contains(port);

    private readonly SandboxService _sandboxService;
    private readonly IUserStoryRepository _userStoryRepository;
    private readonly IStorySandboxConversationRepository _storySandboxConversationRepository;
    private readonly IConfiguration _configuration;
    private readonly ILogger<SandboxProxyController> _logger;

    public SandboxProxyController(
        SandboxService sandboxService,
        IUserStoryRepository userStoryRepository,
        IStorySandboxConversationRepository storySandboxConversationRepository,
        IConfiguration configuration,
        ILogger<SandboxProxyController> logger)
    {
        _sandboxService = sandboxService;
        _userStoryRepository = userStoryRepository;
        _storySandboxConversationRepository = storySandboxConversationRepository;
        _configuration = configuration;
        _logger = logger;
    }

    // ── Bridge HTTP proxy ────────────────────────────────────────────────────

    [Authorize]
    [HttpGet("bridge/{**subpath}")]
    [HttpPost("bridge/{**subpath}")]
    [HttpPut("bridge/{**subpath}")]
    [HttpDelete("bridge/{**subpath}")]
    [HttpPatch("bridge/{**subpath}")]
    public async Task<IActionResult> ProxyBridge(string sandboxId, string? subpath)
    {
        var info = await ResolveInfoAsync(sandboxId);
        if (info is null) return NotFound(new { error = "Sandbox not found" });

        var upstreamQuery = BuildBridgeQueryStringExcludingStoryId(Request.Query);
        var bridgeBase = ResolveManagerBridgeBase(sandboxId, info.InternalBridgeUrl);
        var target = BuildUpstreamUrl(bridgeBase, subpath, upstreamQuery);

        var storyIdRaw = Request.Query["storyId"].FirstOrDefault();
        var persistStoryId = Guid.TryParse(storyIdRaw, out var storyGuid) ? storyGuid : (Guid?)null;
        var isGetAllConversations = HttpMethods.IsGet(Request.Method)
            && string.Equals(subpath, "all-conversations", StringComparison.OrdinalIgnoreCase);

        if (isGetAllConversations && persistStoryId is not null)
            return await ForwardBridgeGetBufferedAndPersistAsync(target, info.SandboxToken, persistStoryId.Value, sandboxId);

        return await ForwardHttpAsync(target, info.SandboxToken);
    }

    // ── In-sandbox app preview (HTTP only; e.g. Vite/webpack dev server) ────
    // AllowAnonymous: iframe / window.open cannot attach JWT (same model as VNC).
    // Access is gated by knowing the sandbox ID.

    [AllowAnonymous]
    [HttpGet("preview/{previewPort:int}")]
    [HttpPost("preview/{previewPort:int}")]
    [HttpPut("preview/{previewPort:int}")]
    [HttpDelete("preview/{previewPort:int}")]
    [HttpPatch("preview/{previewPort:int}")]
    [HttpHead("preview/{previewPort:int}")]
    [HttpOptions("preview/{previewPort:int}")]
    public Task<IActionResult> ProxyPreviewAtRoot(string sandboxId, int previewPort) =>
        ProxyPreviewInternalAsync(sandboxId, previewPort, subpath: null);

    [AllowAnonymous]
    [HttpGet("preview/{previewPort:int}/{**subpath}")]
    [HttpPost("preview/{previewPort:int}/{**subpath}")]
    [HttpPut("preview/{previewPort:int}/{**subpath}")]
    [HttpDelete("preview/{previewPort:int}/{**subpath}")]
    [HttpPatch("preview/{previewPort:int}/{**subpath}")]
    [HttpHead("preview/{previewPort:int}/{**subpath}")]
    [HttpOptions("preview/{previewPort:int}/{**subpath}")]
    public Task<IActionResult> ProxyPreview(string sandboxId, int previewPort, string subpath) =>
        ProxyPreviewInternalAsync(sandboxId, previewPort, subpath);

    private async Task<IActionResult> ProxyPreviewInternalAsync(string sandboxId, int previewPort, string? subpath)
    {
        if (!IsPreviewPortAllowed(previewPort))
            return BadRequest(new { error = $"Preview port {previewPort} is blocked (internal service or invalid)." });

        var info = await _sandboxService.TryGetOrRediscoverByIdAsync(sandboxId, HttpContext.RequestAborted);
        if (info is null)
        {
            _logger.LogWarning(
                "Preview: could not resolve sandbox {SandboxId} (not in server map and manager GET failed or returned no bridge_url). Check VPS:GatewayUrl and manager API key.",
                sandboxId);
            return NotFound(new { error = "Sandbox not found" });
        }

        if (!TryBuildPreviewUpstreamTarget(sandboxId, info, previewPort, subpath, Request.QueryString.Value, out var target))
        {
            return StatusCode(503, new
            {
                error = "Preview proxy is only available for manager-style bridge URLs (/sandbox/{id}/bridge).",
            });
        }

        _logger.LogInformation("Preview proxy → manager {Url}", target);
        // Rewriting HTML <base href> lets the browser resolve every relative
        // asset (styles.css, runtime.js, …) against the public preview prefix
        // instead of the backend root, where they would 404.
        var previewMountPath = $"/api/sandboxes/{sandboxId}/preview/{previewPort}/";
        return await ForwardHttpAsync(target, sandboxToken: null, htmlRewritePrefix: previewMountPath);
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

        var vncBase = ResolveManagerVncBase(sandboxId, info.InternalVncUrl);
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

        var vncBase = ResolveManagerVncBase(sandboxId, info.InternalVncUrl);
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
    /// Same host the API already uses for manager API calls (<see cref="SandboxService"/>).
    /// Stored <c>bridge_url</c> often uses <c>localhost</c>, which is wrong when the API runs in Docker.
    /// </summary>
    private string? GetVpsGatewayTrimmed() =>
        _configuration["VPS:GatewayUrl"]?.Trim().TrimEnd('/');

    private static bool IsManagerDockerStyleBridgeUrl(string bridgeUrl)
    {
        var t = bridgeUrl.TrimEnd('/');
        return bridgeUrl.Contains("/sandbox/", StringComparison.OrdinalIgnoreCase)
               && t.EndsWith("/bridge", StringComparison.OrdinalIgnoreCase);
    }

    private string ResolveManagerBridgeBase(string sandboxId, string internalBridgeUrl)
    {
        var gw = GetVpsGatewayTrimmed();
        if (!string.IsNullOrEmpty(gw) && IsManagerDockerStyleBridgeUrl(internalBridgeUrl))
            return $"{gw}/sandbox/{sandboxId}/bridge";
        return internalBridgeUrl.TrimEnd('/');
    }

    private string ResolveManagerVncBase(string sandboxId, string internalVncUrl)
    {
        var gw = GetVpsGatewayTrimmed();
        if (!string.IsNullOrEmpty(gw)
            && internalVncUrl.Contains($"/sandbox/{sandboxId}/", StringComparison.OrdinalIgnoreCase))
            return $"{gw}/sandbox/{sandboxId}/vnc";
        return ExtractVncBasePath(internalVncUrl);
    }

    private bool TryBuildPreviewUpstreamTarget(
        string sandboxId,
        SandboxInternalInfo info,
        int previewPort,
        string? subpath,
        string? queryString,
        [NotNullWhen(true)] out string? target)
    {
        target = null;
        var gw = GetVpsGatewayTrimmed();
        if (!string.IsNullOrEmpty(gw) && IsManagerDockerStyleBridgeUrl(info.InternalBridgeUrl))
        {
            var previewBase = $"{gw}/sandbox/{sandboxId}/preview/{previewPort}";
            target = BuildUpstreamUrl(previewBase, subpath, queryString);
            return true;
        }

        if (TryBuildPreviewBaseUrl(info.InternalBridgeUrl, previewPort, out var previewBaseLegacy))
        {
            target = BuildUpstreamUrl(previewBaseLegacy, subpath, queryString);
            return true;
        }

        return false;
    }

    /// <summary>
    /// Maps <c>…/sandbox/{id}/bridge</c> to <c>…/sandbox/{id}/preview/{previewPort}</c> on the manager.
    /// </summary>
    private static bool TryBuildPreviewBaseUrl(string internalBridgeUrl, int previewPort, [NotNullWhen(true)] out string? previewBase)
    {
        previewBase = null;
        var trimmed = internalBridgeUrl.TrimEnd('/');
        const string bridgeSuffix = "/bridge";
        if (trimmed.Length < bridgeSuffix.Length
            || !trimmed.EndsWith(bridgeSuffix, StringComparison.OrdinalIgnoreCase))
            return false;

        previewBase = trimmed[..^bridgeSuffix.Length] + $"/preview/{previewPort}";
        return true;
    }

    /// <summary>
    /// <c>storyId</c> is only for backend persistence; the sandbox bridge must not receive it.
    /// </summary>
    private static string BuildBridgeQueryStringExcludingStoryId(IQueryCollection query)
    {
        var parts = new List<string>();
        foreach (var kv in query)
        {
            if (string.Equals(kv.Key, "storyId", StringComparison.OrdinalIgnoreCase))
                continue;
            foreach (var v in kv.Value)
                parts.Add($"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(v ?? string.Empty)}");
        }

        return parts.Count == 0 ? string.Empty : "?" + string.Join("&", parts);
    }

    private async Task<IActionResult> ForwardBridgeGetBufferedAndPersistAsync(
        string targetUrl,
        string? sandboxToken,
        Guid userStoryId,
        string sandboxId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
            return Unauthorized();

        var story = await _userStoryRepository.GetByIdAsync(userStoryId, HttpContext.RequestAborted);
        if (story?.Feature?.Epic?.Repository is null)
            return NotFound(new { error = "User story not found" });
        if (story.Feature.Epic.Repository.UserId != userId)
            return Forbid();

        using var client = CreateSandboxProxyHttpClient();
        using var req = new HttpRequestMessage(HttpMethod.Get, targetUrl);
        if (!string.IsNullOrEmpty(sandboxToken))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", sandboxToken);

        HttpResponseMessage upstream;
        try
        {
            upstream = await client.SendAsync(req, HttpCompletionOption.ResponseContentRead, HttpContext.RequestAborted);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Proxy request to {Url} failed", targetUrl);
            return StatusCode(502, new { error = "Upstream unreachable" });
        }

        var bytes = await upstream.Content.ReadAsByteArrayAsync(HttpContext.RequestAborted);

        if (upstream.IsSuccessStatusCode)
        {
            try
            {
                var json = Encoding.UTF8.GetString(bytes);
                await _storySandboxConversationRepository.UpsertAsync(userStoryId, sandboxId, json, HttpContext.RequestAborted);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex,
                    "Failed to persist sandbox conversation snapshot for story {StoryId} sandbox {SandboxId}",
                    userStoryId, sandboxId);
            }
        }

        Response.StatusCode = (int)upstream.StatusCode;

        foreach (var header in upstream.Content.Headers)
            Response.Headers[header.Key] = header.Value.ToArray();
        foreach (var header in upstream.Headers)
        {
            if (header.Key.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase))
                continue;
            Response.Headers[header.Key] = header.Value.ToArray();
        }

        await Response.Body.WriteAsync(bytes, HttpContext.RequestAborted);
        return new EmptyResult();
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

    /// <summary>Short connect timeout so bad manager/dev-server routes fail fast (avoids 2+ minute hangs).</summary>
    private static HttpClient CreateSandboxProxyHttpClient()
    {
        var handler = new SocketsHttpHandler
        {
            ConnectTimeout = TimeSpan.FromSeconds(10),
        };
        return new HttpClient(handler, disposeHandler: true)
        {
            Timeout = TimeSpan.FromSeconds(90),
        };
    }

    private Task<IActionResult> ForwardHttpAsync(string targetUrl, string? sandboxToken) =>
        ForwardHttpAsync(targetUrl, sandboxToken, htmlRewritePrefix: null);

    private async Task<IActionResult> ForwardHttpAsync(string targetUrl, string? sandboxToken, string? htmlRewritePrefix)
    {
        using var client = CreateSandboxProxyHttpClient();

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
        catch (OperationCanceledException oce)
        {
            if (HttpContext.RequestAborted.IsCancellationRequested) throw;
            _logger.LogWarning(oce, "Proxy timeout waiting for {Url}", targetUrl);
            return StatusCode(504, new { error = "Upstream timed out (check dev server: ng serve --host 0.0.0.0 --port …)" });
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Proxy request to {Url} failed", targetUrl);
            return StatusCode(502, new { error = "Upstream unreachable" });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Proxy request to {Url} failed", targetUrl);
            return StatusCode(502, new { error = "Upstream unreachable" });
        }

        Response.StatusCode = (int)upstream.StatusCode;

        var isHtml = htmlRewritePrefix is not null
            && upstream.Content.Headers.ContentType?.MediaType?
                .Equals("text/html", StringComparison.OrdinalIgnoreCase) == true;

        foreach (var header in upstream.Content.Headers)
        {
            // Rewriting the body changes its length; drop Content-Length to let Kestrel chunk.
            if (isHtml && header.Key.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
            Response.Headers[header.Key] = header.Value.ToArray();
        }
        foreach (var header in upstream.Headers)
        {
            if (header.Key.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase)) continue;
            Response.Headers[header.Key] = header.Value.ToArray();
        }

        if (isHtml)
        {
            var html = await upstream.Content.ReadAsStringAsync(HttpContext.RequestAborted);
            var rewritten = RewritePreviewHtml(html, htmlRewritePrefix!);
            var bytes = Encoding.UTF8.GetBytes(rewritten);
            await Response.Body.WriteAsync(bytes, HttpContext.RequestAborted);
        }
        else
        {
            await upstream.Content.CopyToAsync(Response.Body, HttpContext.RequestAborted);
        }
        return new EmptyResult();
    }

    // ── HTML rewriting for the preview proxy ─────────────────────────────────
    // Angular/Vite emit `<base href="/">` plus many absolute `/foo` attributes,
    // which resolve against the backend root instead of the preview prefix.
    // We rewrite once on the HTML document; runtime fetches using absolute
    // paths are caught by PreviewAssetFallbackController via the Referer.

    private static readonly Regex BaseHrefRegex = new(
        "<base\\b[^>]*\\bhref\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)[^>]*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex HeadOpenRegex = new(
        "<head\\b[^>]*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Only rewrites root-relative paths (single leading slash). Protocol-relative
    // (`//host/…`) and absolute URLs are preserved so CDN assets keep working.
    private static readonly Regex RootAbsoluteAttrRegex = new(
        "\\b(src|href|action|poster|data-src)\\s*=\\s*(\"|')/(?!/)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    internal static string RewritePreviewHtml(string html, string prefix)
    {
        var safePrefix = prefix.EndsWith('/') ? prefix : prefix + "/";
        // strip trailing slash for attribute rewrites so we don't produce `//…` paths.
        var attrPrefix = safePrefix.TrimEnd('/');

        // 1) Drop any existing <base> tag first — it's always `/` in Angular/Vite
        //    builds and would otherwise fight with (or get mangled by) the rewrites
        //    below.
        html = BaseHrefRegex.Replace(html, string.Empty);

        // 2) Rewrite root-absolute attributes. Must run before we inject our own
        //    <base href="/api/sandboxes/…/"> — otherwise this regex would match
        //    the href we just added and double the prefix.
        html = RootAbsoluteAttrRegex.Replace(html, m =>
        {
            var attr = m.Groups[1].Value;
            var quote = m.Groups[2].Value;
            return $"{attr}={quote}{attrPrefix}/";
        });

        // 3) Finally, inject a fresh <base> right after <head> so every relative
        //    asset resolves against the preview prefix.
        var baseTag = $"<base href=\"{safePrefix}\">";
        html = HeadOpenRegex.IsMatch(html)
            ? HeadOpenRegex.Replace(html, m => m.Value + baseTag, 1)
            : baseTag + html;

        return html;
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
