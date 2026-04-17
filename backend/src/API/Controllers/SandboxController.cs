namespace DevPilot.API.Controllers;

using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Serialization;
using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Authenticated proxy for sandbox container management.
/// All calls require a valid JWT; the backend forwards them to the VPS manager
/// using the internal API key, which is never exposed to the browser.
///
/// AI config, MCP servers, and Zed settings are resolved entirely server-side
/// so the browser never handles API keys or MCP secrets.
/// </summary>
[ApiController]
[Route("api/sandboxes")]
[Authorize]
public class SandboxController : ControllerBase
{
    private readonly ISandboxService _sandboxService;
    private readonly IUserRepository _userRepository;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IEffectiveAiConfigResolver _aiConfigResolver;
    private readonly IMcpServerConfigRepository _mcpRepository;
    private readonly IUserStoryRepository _userStoryRepository;
    private readonly IRepositoryAgentRuleRepository _repositoryAgentRuleRepository;
    private readonly ILogger<SandboxController> _logger;

    public SandboxController(
        ISandboxService sandboxService,
        IUserRepository userRepository,
        IRepositoryRepository repositoryRepository,
        IEffectiveAiConfigResolver aiConfigResolver,
        IMcpServerConfigRepository mcpRepository,
        IUserStoryRepository userStoryRepository,
        IRepositoryAgentRuleRepository repositoryAgentRuleRepository,
        ILogger<SandboxController> logger)
    {
        _sandboxService = sandboxService;
        _userRepository = userRepository;
        _repositoryRepository = repositoryRepository;
        _aiConfigResolver = aiConfigResolver;
        _mcpRepository = mcpRepository;
        _userStoryRepository = userStoryRepository;
        _repositoryAgentRuleRepository = repositoryAgentRuleRepository;
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
            var azureDevOpsPat = request.AzureDevOpsPat;
            if (string.IsNullOrEmpty(azureDevOpsPat) && request.ArtifactFeeds?.Count > 0)
            {
                var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
                azureDevOpsPat = user?.AzureDevOpsAccessToken;
            }

            string? azureIdClientId = null, azureIdClientSecret = null, azureIdTenantId = null;
            Repository? resolvedRepo = null;
            Guid? repositoryId = null;
            if (!string.IsNullOrEmpty(request.RepoName))
            {
                var userRepos = await _repositoryRepository.GetByUserIdAsync(userId, cancellationToken);
                resolvedRepo = userRepos.FirstOrDefault(r => r.Name == request.RepoName);
                if (resolvedRepo != null)
                {
                    repositoryId = resolvedRepo.Id;
                    if (!string.IsNullOrEmpty(resolvedRepo.AzureIdentityClientId) && !string.IsNullOrEmpty(resolvedRepo.AzureIdentityClientSecret) && !string.IsNullOrEmpty(resolvedRepo.AzureIdentityTenantId))
                    {
                        azureIdClientId = resolvedRepo.AzureIdentityClientId;
                        azureIdClientSecret = resolvedRepo.AzureIdentityClientSecret;
                        azureIdTenantId = resolvedRepo.AzureIdentityTenantId;
                    }
                }
            }

            string? agentRulesForSandbox = request.AgentRules;
            if (resolvedRepo != null)
            {
                agentRulesForSandbox = await AgentRulesResolver.ResolveAsync(
                    resolvedRepo,
                    request.StoryId,
                    request.AgentRules,
                    _repositoryAgentRuleRepository,
                    _userStoryRepository,
                    cancellationToken);
            }

            // Resolve AI config entirely server-side (never trust frontend with API keys)
            var aiConfig = await _aiConfigResolver.GetEffectiveConfigAsync(userId, repositoryId, cancellationToken);
            SandboxAiConfig? sandboxAiConfig = null;
            if (!string.IsNullOrEmpty(aiConfig.ApiKey))
            {
                sandboxAiConfig = new SandboxAiConfig
                {
                    Provider = aiConfig.Provider,
                    ApiKey = aiConfig.ApiKey,
                    Model = aiConfig.Model ?? "gpt-4o",
                    BaseUrl = aiConfig.BaseUrl,
                };
            }

            // Build Zed settings server-side (includes MCP secrets)
            var mcpServers = await _mcpRepository.GetEnabledForUserAsync(userId, cancellationToken);
            var zedSettings = BuildZedSettings(aiConfig, mcpServers);

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
                    AzureDevOpsPat = azureDevOpsPat,
                    AiConfig = sandboxAiConfig,
                    ZedSettings = zedSettings,
                    ArtifactFeeds = request.ArtifactFeeds?.Select(f => new SandboxArtifactFeed
                    {
                        Name = f.Name,
                        Organization = f.Organization,
                        FeedName = f.FeedName,
                        ProjectName = f.ProjectName,
                        FeedType = f.FeedType,
                    }).ToList(),
                    AgentRules = agentRulesForSandbox,
                    AzureIdentityClientId = azureIdClientId,
                    AzureIdentityClientSecret = azureIdClientSecret,
                    AzureIdentityTenantId = azureIdTenantId,
                },
                cancellationToken);

            return Ok(new SandboxResponse
            {
                Id = result.Id,
                Status = result.Status,
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

        return Ok(new { id = result.Id, status = result.Status });
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

    // ── Zed settings builder (mirrors frontend getZedSettingsJson) ────────────

    private static object BuildZedSettings(EffectiveAiConfig ai, IReadOnlyList<McpServerConfig> mcpServers)
    {
        var zedProvider = ai.Provider == "custom" ? "openai" : ai.Provider;
        var model = ai.Model ?? "gpt-4o";

        var settings = new Dictionary<string, object>
        {
            ["theme"] = "One Dark",
            ["ui_font_size"] = 14,
            ["buffer_font_size"] = 14,
            ["agent"] = new Dictionary<string, object>
            {
                ["enabled"] = true,
                ["default_model"] = new Dictionary<string, object>
                {
                    ["provider"] = zedProvider,
                    ["model"] = model,
                },
                ["always_allow_tool_actions"] = true,
            },
            ["features"] = new Dictionary<string, object>
            {
                ["edit_prediction_provider"] = "zed",
            },
            ["terminal"] = new Dictionary<string, object>
            {
                ["dock"] = "bottom",
                ["env"] = new Dictionary<string, object>
                {
                    ["LIBGL_ALWAYS_SOFTWARE"] = "1",
                },
            },
            ["worktree"] = new Dictionary<string, object>
            {
                ["trust_by_default"] = true,
            },
            ["telemetry"] = new Dictionary<string, object>
            {
                ["diagnostics"] = false,
                ["metrics"] = false,
            },
            ["workspace"] = new Dictionary<string, object>
            {
                ["title_bar"] = new Dictionary<string, object>
                {
                    ["show_onboarding_banner"] = false,
                },
            },
            ["show_call_status_icon"] = false,
        };

        if (ai.Provider == "ollama")
        {
            settings["language_models"] = new Dictionary<string, object>
            {
                ["ollama"] = new Dictionary<string, object>
                {
                    ["api_url"] = ai.BaseUrl ?? "http://localhost:11434",
                },
            };
        }
        else
        {
            settings["language_models"] = new Dictionary<string, object>
            {
                ["openai"] = new Dictionary<string, object>
                {
                    ["api_url"] = "http://localhost:8091/v1",
                    ["available_models"] = new[]
                    {
                        new Dictionary<string, object>
                        {
                            ["name"] = model,
                            ["display_name"] = model,
                            ["max_tokens"] = 128000,
                        },
                    },
                },
            };
        }

        if (mcpServers.Count > 0)
        {
            var contextServers = new Dictionary<string, object>();
            foreach (var mcp in mcpServers)
            {
                if (mcp.ServerType == "remote")
                {
                    var entry = new Dictionary<string, object>();
                    if (!string.IsNullOrEmpty(mcp.Url))
                        entry["url"] = mcp.Url;
                    if (!string.IsNullOrEmpty(mcp.HeadersJson))
                    {
                        var headers = JsonSerializer.Deserialize<Dictionary<string, string>>(mcp.HeadersJson);
                        if (headers?.Count > 0) entry["headers"] = headers;
                    }
                    contextServers[mcp.Name] = entry;
                }
                else
                {
                    var entry = new Dictionary<string, object>();
                    if (!string.IsNullOrEmpty(mcp.Command))
                        entry["command"] = mcp.Command;
                    if (!string.IsNullOrEmpty(mcp.Args))
                    {
                        var args = JsonSerializer.Deserialize<string[]>(mcp.Args);
                        if (args?.Length > 0) entry["args"] = args;
                    }
                    if (!string.IsNullOrEmpty(mcp.EnvJson))
                    {
                        var env = JsonSerializer.Deserialize<Dictionary<string, string>>(mcp.EnvJson);
                        if (env?.Count > 0) entry["env"] = env;
                    }
                    contextServers[mcp.Name] = entry;
                }
            }
            settings["context_servers"] = contextServers;
        }

        return settings;
    }
}

// ── Request / Response DTOs ──────────────────────────────────────────────────

/// <summary>
/// Sandbox creation request from the frontend.
/// AI config, MCP secrets, and Zed settings are resolved server-side —
/// the frontend only sends repo info and non-secret parameters.
/// </summary>
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

    [JsonPropertyName("artifact_feeds")]
    public List<ArtifactFeedPayload>? ArtifactFeeds { get; set; }

    [JsonPropertyName("agent_rules")]
    public string? AgentRules { get; set; }

    /// <summary>When set, agent rules are resolved from this story's chosen rule (or repo default).</summary>
    [JsonPropertyName("story_id")]
    public Guid? StoryId { get; set; }
}

public class ArtifactFeedPayload
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("organization")]
    public string Organization { get; set; } = "";

    [JsonPropertyName("feedName")]
    public string FeedName { get; set; } = "";

    [JsonPropertyName("projectName")]
    public string? ProjectName { get; set; }

    [JsonPropertyName("feedType")]
    public string FeedType { get; set; } = "nuget";
}

/// <summary>
/// Sandbox response — only exposes sandbox ID, status, and VNC password.
/// Bridge and VNC traffic goes through the proxy at <c>/api/sandboxes/{id}/bridge/…</c>
/// and <c>/api/sandboxes/{id}/vnc/…</c>.
/// </summary>
public class SandboxResponse
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; set; } = string.Empty;

    [JsonPropertyName("vnc_password")]
    public string VncPassword { get; set; } = string.Empty;
}
