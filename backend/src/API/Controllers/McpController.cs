namespace DevPilot.API.Controllers;

using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// CRUD for MCP (Model Context Protocol) server configurations.
/// Personal configs are scoped to the authenticated user; shared configs are admin-only.
/// </summary>
[ApiController]
[Route("api/[controller]")]
[Authorize]
public class McpController : ControllerBase
{
    private readonly IMcpServerConfigRepository _repo;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<McpController> _logger;

    public McpController(IMcpServerConfigRepository repo, IHttpClientFactory httpClientFactory, ILogger<McpController> logger)
    {
        _repo = repo;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    // ── Personal + shared list ──────────────────────────────────────────

    /// <summary>
    /// Returns all MCP servers visible to the current user (personal + shared).
    /// Secrets in env/headers are masked.
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetAll(CancellationToken ct)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();

        var personal = await _repo.GetByUserIdAsync(userId.Value, ct);
        var shared = await _repo.GetSharedAsync(ct);

        var result = personal.Select(s => MapDto(s, maskSecrets: true))
            .Concat(shared.Select(s => MapDto(s, maskSecrets: true)))
            .ToList();

        return Ok(result);
    }

    /// <summary>
    /// Returns all enabled MCP servers for the current user, with full secrets (for sandbox injection).
    /// </summary>
    [HttpGet("enabled")]
    public async Task<IActionResult> GetEnabled(CancellationToken ct)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();

        var list = await _repo.GetEnabledForUserAsync(userId.Value, ct);
        return Ok(list.Select(s => MapDto(s, maskSecrets: false)).ToList());
    }

    // ── Personal CRUD ───────────────────────────────────────────────────

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateMcpServerRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();

        if (!ValidateRequest(request, out var error))
            return BadRequest(new { message = error });

        var entity = new McpServerConfig(
            userId.Value,
            request.Name!,
            request.ServerType!,
            request.Command,
            SerializeArgs(request.Args),
            SerializeJson(request.Env),
            request.Url,
            SerializeJson(request.Headers),
            request.IsEnabled ?? true);

        entity = await _repo.AddAsync(entity, ct);
        _logger.LogInformation("User {UserId} created MCP server config: {Name}", userId, request.Name);
        return Ok(MapDto(entity, maskSecrets: true));
    }

    [HttpPatch("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateMcpServerRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();

        var entity = await _repo.GetByIdAsync(id, ct);
        if (entity == null || entity.UserId != userId.Value) return NotFound();

        entity.Update(
            request.Name,
            request.ServerType,
            request.Command,
            request.Args != null ? SerializeArgs(request.Args) : null,
            request.Env != null ? SerializeJson(request.Env) : null,
            request.Url,
            request.Headers != null ? SerializeJson(request.Headers) : null);

        if (request.IsEnabled.HasValue)
            entity.SetEnabled(request.IsEnabled.Value);

        await _repo.UpdateAsync(entity, ct);
        return Ok(MapDto(entity, maskSecrets: true));
    }

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();

        var entity = await _repo.GetByIdAsync(id, ct);
        if (entity == null || entity.UserId != userId.Value) return NotFound();

        await _repo.DeleteAsync(id, ct);
        return Ok(new { message = "MCP server config deleted" });
    }

    [HttpPost("{id:guid}/toggle")]
    public async Task<IActionResult> Toggle(Guid id, CancellationToken ct)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();

        var entity = await _repo.GetByIdAsync(id, ct);
        if (entity == null || entity.UserId != userId.Value) return NotFound();

        entity.SetEnabled(!entity.IsEnabled);
        await _repo.UpdateAsync(entity, ct);
        return Ok(MapDto(entity, maskSecrets: true));
    }

    // ── Tool discovery ──────────────────────────────────────────────────

    /// <summary>
    /// Connects to a remote MCP server via JSON-RPC and returns the list of tools it exposes.
    /// Only supported for remote HTTP servers.
    /// </summary>
    [HttpPost("{id:guid}/tools")]
    public async Task<IActionResult> DiscoverTools(Guid id, CancellationToken ct)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();

        var entity = await _repo.GetByIdAsync(id, ct);
        if (entity == null) return NotFound();

        if (!entity.IsShared && entity.UserId != userId.Value) return NotFound();

        if (entity.ServerType != "remote")
            return BadRequest(new { message = "Tool discovery is only supported for remote HTTP MCP servers." });

        if (string.IsNullOrWhiteSpace(entity.Url))
            return BadRequest(new { message = "Server URL is not configured." });

        try
        {
            var tools = await DiscoverMcpToolsAsync(entity, ct);
            return Ok(tools);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to discover tools for MCP server {Name}", entity.Name);
            return StatusCode(502, new { message = $"Failed to connect to MCP server: {ex.Message}" });
        }
    }

    private async Task<List<McpToolInfo>> DiscoverMcpToolsAsync(McpServerConfig config, CancellationToken ct)
    {
        var client = _httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(15);

        if (!string.IsNullOrEmpty(config.HeadersJson))
        {
            var headers = JsonSerializer.Deserialize<Dictionary<string, string>>(config.HeadersJson);
            if (headers != null)
            {
                foreach (var (key, value) in headers)
                    client.DefaultRequestHeaders.TryAddWithoutValidation(key, value);
            }
        }

        var initPayload = new
        {
            jsonrpc = "2.0",
            method = "initialize",
            @params = new
            {
                protocolVersion = "2024-11-05",
                capabilities = new { },
                clientInfo = new { name = "DevPilot", version = "1.0.0" }
            },
            id = 1
        };

        var initResponse = await SendJsonRpcAsync(client, config.Url!, initPayload, null, ct);
        var initBody = await ReadJsonRpcBodyAsync(initResponse, ct);

        string? sessionId = null;
        if (initResponse.Headers.TryGetValues("Mcp-Session-Id", out var sessionValues))
            sessionId = sessionValues.FirstOrDefault();

        var initializedNotif = new { jsonrpc = "2.0", method = "notifications/initialized" };
        var notifResponse = await SendJsonRpcAsync(client, config.Url!, initializedNotif, sessionId, ct);
        notifResponse.Dispose();

        var toolsPayload = new { jsonrpc = "2.0", method = "tools/list", id = 2 };
        var toolsResponse = await SendJsonRpcAsync(client, config.Url!, toolsPayload, sessionId, ct);
        var toolsBody = await ReadJsonRpcBodyAsync(toolsResponse, ct);

        using var doc = JsonDocument.Parse(toolsBody);

        if (doc.RootElement.TryGetProperty("error", out var err))
            throw new InvalidOperationException(err.TryGetProperty("message", out var msg) ? msg.GetString() : "MCP server returned an error");

        var result = doc.RootElement.GetProperty("result");
        var tools = result.GetProperty("tools");

        var toolList = new List<McpToolInfo>();
        foreach (var tool in tools.EnumerateArray())
        {
            toolList.Add(new McpToolInfo
            {
                Name = tool.GetProperty("name").GetString()!,
                Description = tool.TryGetProperty("description", out var desc) ? desc.GetString() : null,
                InputSchema = tool.TryGetProperty("inputSchema", out var schema) ? schema.ToString() : null,
            });
        }

        return toolList;
    }

    private static async Task<HttpResponseMessage> SendJsonRpcAsync(HttpClient client, string url, object payload, string? sessionId, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));

        if (sessionId != null)
            request.Headers.Add("Mcp-Session-Id", sessionId);

        var response = await client.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        return response;
    }

    /// <summary>
    /// Reads the JSON-RPC body from either a plain JSON or SSE response.
    /// </summary>
    private static async Task<string> ReadJsonRpcBodyAsync(HttpResponseMessage response, CancellationToken ct)
    {
        var contentType = response.Content.Headers.ContentType?.MediaType;

        if (contentType == "text/event-stream")
        {
            var stream = await response.Content.ReadAsStreamAsync(ct);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            string? lastData = null;

            while (await reader.ReadLineAsync(ct) is { } line)
            {
                if (line.StartsWith("data: ", StringComparison.Ordinal))
                    lastData = line[6..];
                else if (line.Length == 0 && lastData != null)
                    return lastData;
            }

            if (lastData != null) return lastData;
            throw new InvalidOperationException("No JSON-RPC response found in SSE stream");
        }

        return await response.Content.ReadAsStringAsync(ct);
    }

    // ── Admin (shared) CRUD ─────────────────────────────────────────────

    [HttpGet("admin")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> AdminGetAll(CancellationToken ct)
    {
        var list = await _repo.GetSharedAsync(ct);
        return Ok(list.Select(s => MapDto(s, maskSecrets: true)).ToList());
    }

    [HttpPost("admin")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> AdminCreate([FromBody] CreateMcpServerRequest request, CancellationToken ct)
    {
        if (!ValidateRequest(request, out var error))
            return BadRequest(new { message = error });

        var entity = McpServerConfig.CreateShared(
            request.Name!,
            request.ServerType!,
            request.Command,
            SerializeArgs(request.Args),
            SerializeJson(request.Env),
            request.Url,
            SerializeJson(request.Headers));

        entity = await _repo.AddAsync(entity, ct);
        _logger.LogInformation("Admin created shared MCP server config: {Name}", request.Name);
        return Ok(MapDto(entity, maskSecrets: true));
    }

    [HttpPatch("admin/{id:guid}")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> AdminUpdate(Guid id, [FromBody] UpdateMcpServerRequest request, CancellationToken ct)
    {
        var entity = await _repo.GetByIdAsync(id, ct);
        if (entity == null) return NotFound();

        entity.Update(
            request.Name,
            request.ServerType,
            request.Command,
            request.Args != null ? SerializeArgs(request.Args) : null,
            request.Env != null ? SerializeJson(request.Env) : null,
            request.Url,
            request.Headers != null ? SerializeJson(request.Headers) : null);

        if (request.IsEnabled.HasValue)
            entity.SetEnabled(request.IsEnabled.Value);

        await _repo.UpdateAsync(entity, ct);
        return Ok(MapDto(entity, maskSecrets: true));
    }

    [HttpDelete("admin/{id:guid}")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> AdminDelete(Guid id, CancellationToken ct)
    {
        var entity = await _repo.GetByIdAsync(id, ct);
        if (entity == null) return NotFound();

        await _repo.DeleteAsync(id, ct);
        return Ok(new { message = "Shared MCP server config deleted" });
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private Guid? GetUserId()
    {
        var claim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(claim, out var id) ? id : null;
    }

    private static bool ValidateRequest(CreateMcpServerRequest request, out string error)
    {
        error = string.Empty;

        if (string.IsNullOrWhiteSpace(request.Name))
        { error = "Name is required."; return false; }

        if (request.ServerType is not ("stdio" or "remote"))
        { error = "ServerType must be 'stdio' or 'remote'."; return false; }

        if (request.ServerType == "stdio" && string.IsNullOrWhiteSpace(request.Command))
        { error = "Command is required for stdio servers."; return false; }

        if (request.ServerType == "remote" && string.IsNullOrWhiteSpace(request.Url))
        { error = "Url is required for remote servers."; return false; }

        if (request.ServerType == "remote" && !string.IsNullOrWhiteSpace(request.Url)
            && !Uri.TryCreate(request.Url, UriKind.Absolute, out _))
        { error = "Url must be a valid absolute URL."; return false; }

        return true;
    }

    private static string? SerializeArgs(string[]? args) =>
        args != null ? JsonSerializer.Serialize(args) : null;

    private static string? SerializeJson(Dictionary<string, string>? dict) =>
        dict != null ? JsonSerializer.Serialize(dict) : null;

    private static McpServerDto MapDto(McpServerConfig entity, bool maskSecrets)
    {
        Dictionary<string, string>? env = null;
        Dictionary<string, string>? headers = null;

        if (!string.IsNullOrEmpty(entity.EnvJson))
        {
            var raw = JsonSerializer.Deserialize<Dictionary<string, string>>(entity.EnvJson);
            env = maskSecrets && raw != null
                ? raw.ToDictionary(kv => kv.Key, kv => MaskValue(kv.Key, kv.Value))
                : raw;
        }

        if (!string.IsNullOrEmpty(entity.HeadersJson))
        {
            var raw = JsonSerializer.Deserialize<Dictionary<string, string>>(entity.HeadersJson);
            headers = maskSecrets && raw != null
                ? raw.ToDictionary(kv => kv.Key, kv => MaskValue(kv.Key, kv.Value))
                : raw;
        }

        return new McpServerDto
        {
            Id = entity.Id,
            Name = entity.Name,
            ServerType = entity.ServerType,
            Command = entity.Command,
            Args = !string.IsNullOrEmpty(entity.Args)
                ? JsonSerializer.Deserialize<string[]>(entity.Args) : null,
            Env = env,
            Url = entity.Url,
            Headers = headers,
            IsEnabled = entity.IsEnabled,
            IsShared = entity.IsShared,
            HasEnv = !string.IsNullOrEmpty(entity.EnvJson),
            HasHeaders = !string.IsNullOrEmpty(entity.HeadersJson),
        };
    }

    private static string MaskValue(string key, string value)
    {
        var lowerKey = key.ToLowerInvariant();
        if (lowerKey.Contains("key") || lowerKey.Contains("token") || lowerKey.Contains("secret")
            || lowerKey.Contains("password") || lowerKey.Contains("authorization") || lowerKey.Contains("bearer"))
        {
            return value.Length > 4 ? value[..4] + "****" : "****";
        }
        return value;
    }

    // ── DTOs ────────────────────────────────────────────────────────────

    public class McpServerDto
    {
        public Guid Id { get; set; }
        public required string Name { get; set; }
        public required string ServerType { get; set; }
        public string? Command { get; set; }
        public string[]? Args { get; set; }
        public Dictionary<string, string>? Env { get; set; }
        public string? Url { get; set; }
        public Dictionary<string, string>? Headers { get; set; }
        public bool IsEnabled { get; set; }
        public bool IsShared { get; set; }
        public bool HasEnv { get; set; }
        public bool HasHeaders { get; set; }
    }

    public class CreateMcpServerRequest
    {
        public string? Name { get; set; }
        public string? ServerType { get; set; }
        public string? Command { get; set; }
        public string[]? Args { get; set; }
        public Dictionary<string, string>? Env { get; set; }
        public string? Url { get; set; }
        public Dictionary<string, string>? Headers { get; set; }
        public bool? IsEnabled { get; set; }
    }

    public class UpdateMcpServerRequest
    {
        public string? Name { get; set; }
        public string? ServerType { get; set; }
        public string? Command { get; set; }
        public string[]? Args { get; set; }
        public Dictionary<string, string>? Env { get; set; }
        public string? Url { get; set; }
        public Dictionary<string, string>? Headers { get; set; }
        public bool? IsEnabled { get; set; }
    }

    public class McpToolInfo
    {
        public required string Name { get; set; }
        public string? Description { get; set; }
        public string? InputSchema { get; set; }
    }
}
