namespace DevPilot.API.Controllers;

using System.Security.Claims;
using System.Text.Json.Serialization;
using DevPilot.Application.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Authenticated proxy for sandbox container management.
/// All calls require a valid JWT; the backend forwards them to the VPS manager
/// using the internal API key, which is never exposed to the browser.
/// </summary>
[ApiController]
[Route("api/sandboxes")]
[Authorize]
public class SandboxController : ControllerBase
{
    private readonly ISandboxService _sandboxService;
    private readonly ILogger<SandboxController> _logger;

    public SandboxController(ISandboxService sandboxService, ILogger<SandboxController> logger)
    {
        _sandboxService = sandboxService;
        _logger = logger;
    }

    /// <summary>Returns all active sandboxes owned by the authenticated user.</summary>
    [HttpGet]
    public async Task<IActionResult> ListSandboxes(CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
            return Unauthorized();

        var sandboxes = await _sandboxService.ListSandboxesAsync(userId, cancellationToken);
        return Ok(new { sandboxes = sandboxes.Select(s => new
        {
            id = s.Id,
            port = s.Port,
            bridge_port = s.BridgePort,
            url = s.Url,
            bridge_url = s.BridgeUrl,
            status = s.Status,
        })});
    }

    /// <summary>Creates a new sandbox container for the authenticated user.</summary>
    [HttpPost]
    public async Task<IActionResult> CreateSandbox(
        [FromBody] CreateSandboxRequest request,
        CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
            return Unauthorized();

        try
        {
            var result = await _sandboxService.CreateSandboxAsync(
                userId,
                new SandboxCreateRequest
                {
                    Resolution = request.Resolution,
                    RepoUrl = request.RepoUrl,
                    RepoName = request.RepoName,
                    RepoBranch = request.RepoBranch,
                    RepoArchiveUrl = request.RepoArchiveUrl,
                    GithubToken = request.GithubToken,
                    AzureDevOpsPat = request.AzureDevOpsPat,
                    AiConfig = request.AiConfig is null ? null : new SandboxAiConfig
                    {
                        Provider = request.AiConfig.Provider,
                        ApiKey = request.AiConfig.ApiKey,
                        Model = request.AiConfig.Model,
                        BaseUrl = request.AiConfig.BaseUrl,
                    },
                    ZedSettings = request.ZedSettings,
                },
                cancellationToken);

            return Ok(new SandboxResponse
            {
                Id = result.Id,
                Port = result.Port,
                BridgePort = result.BridgePort,
                Url = result.Url,
                BridgeUrl = result.BridgeUrl,
                Status = result.Status,
                SandboxToken = result.SandboxToken,
                VncPassword = result.VncPassword,
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create sandbox for user {UserId}", userId);
            return StatusCode(500, new { error = "Failed to create sandbox" });
        }
    }

    /// <summary>Returns the status of a sandbox owned by the authenticated user.</summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> GetSandbox(string id, CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
            return Unauthorized();

        var result = await _sandboxService.GetSandboxAsync(userId, id, cancellationToken);
        if (result is null)
            return NotFound();

        return Ok(result);
    }

    /// <summary>Stops and removes a sandbox owned by the authenticated user.</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> DeleteSandbox(string id, CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
            return Unauthorized();

        var deleted = await _sandboxService.DeleteSandboxAsync(userId, id, cancellationToken);
        if (!deleted)
            return NotFound(new { error = "Sandbox not found or not owned by this user" });

        return Ok(new { status = "deleted" });
    }

    private Guid GetUserId()
    {
        var raw = User.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(raw, out var id) ? id : Guid.Empty;
    }
}

// ── Request / Response DTOs ──────────────────────────────────────────────────

public class CreateSandboxRequest
{
    [JsonPropertyName("resolution")]
    public string? Resolution { get; set; }

    [JsonPropertyName("repo_url")]
    public string? RepoUrl { get; set; }

    [JsonPropertyName("repo_name")]
    public string? RepoName { get; set; }

    [JsonPropertyName("repo_branch")]
    public string? RepoBranch { get; set; }

    [JsonPropertyName("repo_archive_url")]
    public string? RepoArchiveUrl { get; set; }

    [JsonPropertyName("github_token")]
    public string? GithubToken { get; set; }

    [JsonPropertyName("azure_devops_pat")]
    public string? AzureDevOpsPat { get; set; }

    [JsonPropertyName("ai_config")]
    public AiConfigRequest? AiConfig { get; set; }

    [JsonPropertyName("zed_settings")]
    public object? ZedSettings { get; set; }
}

public class AiConfigRequest
{
    [JsonPropertyName("provider")]
    public string Provider { get; set; } = "openai";

    [JsonPropertyName("api_key")]
    public string? ApiKey { get; set; }

    [JsonPropertyName("model")]
    public string Model { get; set; } = "gpt-4o";

    [JsonPropertyName("base_url")]
    public string? BaseUrl { get; set; }
}

public class SandboxResponse
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("port")]
    public int Port { get; set; }

    [JsonPropertyName("bridge_port")]
    public int BridgePort { get; set; }

    [JsonPropertyName("url")]
    public string Url { get; set; } = string.Empty;

    [JsonPropertyName("bridge_url")]
    public string BridgeUrl { get; set; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; set; } = string.Empty;

    [JsonPropertyName("sandbox_token")]
    public string SandboxToken { get; set; } = string.Empty;

    [JsonPropertyName("vnc_password")]
    public string VncPassword { get; set; } = string.Empty;
}
