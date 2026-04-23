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
    private readonly ILinkedProviderRepository _linkedProviderRepository;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IEffectiveAiConfigResolver _aiConfigResolver;
    private readonly IMcpServerConfigRepository _mcpRepository;
    private readonly IArtifactFeedConfigRepository _artifactFeedRepository;
    private readonly IUserStoryRepository _userStoryRepository;
    private readonly IRepositoryAgentRuleRepository _repositoryAgentRuleRepository;
    private readonly IUserRepositorySandboxBindingRepository _userRepositorySandboxBindingRepository;
    private readonly ILogger<SandboxController> _logger;

    public SandboxController(
        ISandboxService sandboxService,
        IUserRepository userRepository,
        ILinkedProviderRepository linkedProviderRepository,
        IRepositoryRepository repositoryRepository,
        IEffectiveAiConfigResolver aiConfigResolver,
        IMcpServerConfigRepository mcpRepository,
        IArtifactFeedConfigRepository artifactFeedRepository,
        IUserStoryRepository userStoryRepository,
        IRepositoryAgentRuleRepository repositoryAgentRuleRepository,
        IUserRepositorySandboxBindingRepository userRepositorySandboxBindingRepository,
        ILogger<SandboxController> logger)
    {
        _sandboxService = sandboxService;
        _userRepository = userRepository;
        _linkedProviderRepository = linkedProviderRepository;
        _repositoryRepository = repositoryRepository;
        _aiConfigResolver = aiConfigResolver;
        _mcpRepository = mcpRepository;
        _artifactFeedRepository = artifactFeedRepository;
        _userStoryRepository = userStoryRepository;
        _repositoryAgentRuleRepository = repositoryAgentRuleRepository;
        _userRepositorySandboxBindingRepository = userRepositorySandboxBindingRepository;
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
            // Resolve artifact feeds server-side (same pattern as MCP/AI):
            // if the frontend didn't send a list (code Ask, code Analysis, etc.),
            // fall back to the admin-defined shared catalog so every headless
            // flow gets NuGet/npm/pip configured automatically.
            var artifactFeedsForSandbox = request.ArtifactFeeds?
                .Select(f => new SandboxArtifactFeed
                {
                    Name = f.Name,
                    Organization = f.Organization,
                    FeedName = f.FeedName,
                    ProjectName = f.ProjectName,
                    FeedType = f.FeedType,
                })
                .ToList();

            if (artifactFeedsForSandbox is null || artifactFeedsForSandbox.Count == 0)
            {
                var sharedFeeds = await _artifactFeedRepository.GetEnabledSharedAsync(cancellationToken);
                artifactFeedsForSandbox = sharedFeeds
                    .Select(f => new SandboxArtifactFeed
                    {
                        Name = f.Name,
                        Organization = f.Organization,
                        FeedName = f.FeedName,
                        ProjectName = f.ProjectName,
                        FeedType = f.FeedType,
                    })
                    .ToList();
            }

            var azureDevOpsPat = request.AzureDevOpsPat;
            if (string.IsNullOrEmpty(azureDevOpsPat) && artifactFeedsForSandbox.Count > 0)
            {
                var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
                azureDevOpsPat = user?.AzureDevOpsAccessToken;
            }

            string? azureIdClientId = null, azureIdClientSecret = null, azureIdTenantId = null;
            Repository? resolvedRepo = null;
            Guid? repositoryId = null;

            if (request.RepositoryId is Guid repoGuid && repoGuid != Guid.Empty)
            {
                var byId = await _repositoryRepository.GetByIdIfAccessibleAsync(repoGuid, userId, cancellationToken);
                if (byId is not null)
                {
                    resolvedRepo = byId;
                    repositoryId = byId.Id;
                }
            }

            if (resolvedRepo is null && !string.IsNullOrEmpty(request.RepoName))
            {
                var userRepos = await _repositoryRepository.GetAccessibleByUserIdAsync(userId, cancellationToken);
                resolvedRepo = userRepos.FirstOrDefault(r =>
                    string.Equals(r.Name, request.RepoName, StringComparison.OrdinalIgnoreCase));
                if (resolvedRepo != null)
                {
                    repositoryId = resolvedRepo.Id;
                }
            }

            if (resolvedRepo != null &&
                !string.IsNullOrEmpty(resolvedRepo.AzureIdentityClientId) &&
                !string.IsNullOrEmpty(resolvedRepo.AzureIdentityClientSecret) &&
                !string.IsNullOrEmpty(resolvedRepo.AzureIdentityTenantId))
            {
                azureIdClientId = resolvedRepo.AzureIdentityClientId;
                azureIdClientSecret = resolvedRepo.AzureIdentityClientSecret;
                azureIdTenantId = resolvedRepo.AzureIdentityTenantId;
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

            // If the client sends a plain GitHub URL (no creds), use the current user's linked GitHub token
            // so private repos work for the repo owner and for users a repo is shared with (each uses their own PAT).
            var githubTokenForManager = request.GithubToken;
            if (string.IsNullOrEmpty(githubTokenForManager)
                && !string.IsNullOrEmpty(request.RepoUrl)
                && request.RepoUrl.Contains("github.com", StringComparison.OrdinalIgnoreCase)
                && !request.RepoUrl.Contains("@github.com", StringComparison.OrdinalIgnoreCase))
            {
                var linked = await _linkedProviderRepository.GetByUserAndProviderAsync(
                    userId, ProviderTypes.GitHub, cancellationToken);
                githubTokenForManager = linked?.AccessToken;
                if (string.IsNullOrEmpty(githubTokenForManager))
                {
                    var u = await _userRepository.GetByIdAsync(userId, cancellationToken);
                    githubTokenForManager = u?.GitHubAccessToken;
                }
            }

            var result = await _sandboxService.CreateSandboxAsync(
                userId,
                new SandboxCreateRequest
                {
                    Resolution = request.Resolution,
                    RepoUrl = request.RepoUrl,
                    RepoName = request.RepoName,
                    RepoBranch = request.RepoBranch,
                    RepoArchiveUrl = request.RepoArchiveUrl,
                    GithubToken = githubTokenForManager,
                    AzureDevOpsPat = azureDevOpsPat,
                    AiConfig = sandboxAiConfig,
                    ZedSettings = zedSettings,
                    ArtifactFeeds = artifactFeedsForSandbox.Count > 0 ? artifactFeedsForSandbox : null,
                    AgentRules = agentRulesForSandbox,
                    AzureIdentityClientId = azureIdClientId,
                    AzureIdentityClientSecret = azureIdClientSecret,
                    AzureIdentityTenantId = azureIdTenantId,
                },
                cancellationToken);

            if (repositoryId.HasValue)
            {
                await _userRepositorySandboxBindingRepository.UpsertAsync(
                    userId,
                    repositoryId.Value,
                    result.Id,
                    string.IsNullOrWhiteSpace(request.RepoBranch) ? "main" : request.RepoBranch.Trim(),
                    cancellationToken);
            }

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

    /// <summary>
    /// Returns the active sandbox for Code Ask for this repository (if any), for reconnecting after refresh.
    /// Scoped by authenticated user and repository ownership.
    /// </summary>
    [HttpGet("for-repository/{repositoryId:guid}")]
    public async Task<IActionResult> GetSandboxForRepository(Guid repositoryId, CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
            return Unauthorized();

        var repo = await _repositoryRepository.GetByIdIfAccessibleAsync(repositoryId, userId, cancellationToken);
        if (repo is null)
            return NotFound();

        var binding = await _userRepositorySandboxBindingRepository.GetByUserAndRepositoryAsync(
            userId, repositoryId, cancellationToken);
        if (binding is null)
            return NotFound();

        var adopted = await _sandboxService.TryAssignSandboxOwnershipAsync(userId, binding.SandboxId, cancellationToken);
        if (!adopted)
        {
            await _userRepositorySandboxBindingRepository.DeleteBySandboxIdAsync(binding.SandboxId, cancellationToken);
            return NotFound();
        }

        var status = await _sandboxService.GetSandboxAsync(userId, binding.SandboxId, cancellationToken);
        if (status is null)
        {
            await _userRepositorySandboxBindingRepository.DeleteBySandboxIdAsync(binding.SandboxId, cancellationToken);
            return NotFound();
        }

        var vnc = _sandboxService.GetVncPasswordIfOwnedBy(userId, binding.SandboxId);
        return Ok(new SandboxForRepositoryDto
        {
            Id = binding.SandboxId,
            Status = status.Status,
            RepoBranch = binding.RepoBranch,
            VncPassword = vnc,
        });
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

        await _userRepositorySandboxBindingRepository.DeleteBySandboxIdAsync(id, cancellationToken);

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

    /// <summary>When set, resolves repository ownership and persists Ask sandbox binding reliably (preferred over repo_name alone).</summary>
    [JsonPropertyName("repository_id")]
    public Guid? RepositoryId { get; set; }

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

/// <summary>GET /sandboxes/for-repository/… — reconnect Ask after refresh.</summary>
public class SandboxForRepositoryDto
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; set; } = string.Empty;

    [JsonPropertyName("repo_branch")]
    public string RepoBranch { get; set; } = string.Empty;

    [JsonPropertyName("vnc_password")]
    public string? VncPassword { get; set; }
}
