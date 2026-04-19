namespace DevPilot.Infrastructure.Sandbox;

using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using DevPilot.Application.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

/// <summary>
/// Calls the VPS sandbox manager API using a static API key that is never
/// exposed to the browser.  Tracks sandbox ownership in memory so each user
/// can only read/delete their own sandboxes.
///
/// Internal sandbox URLs (bridge, VNC) are stored server-side and never sent
/// to the browser.  The frontend uses relative paths like
/// <c>/api/sandboxes/{id}/bridge/…</c> which the proxy controller resolves
/// through <see cref="TryGetInternalInfo"/>.
/// </summary>
public class SandboxService : ISandboxService
{
    private readonly HttpClient _httpClient;
    private readonly ILogger<SandboxService> _logger;
    private readonly string _gatewayBaseUrl;

    /// <summary>Per-sandbox ownership + credentials, keyed by sandbox ID.</summary>
    private static readonly ConcurrentDictionary<string, SandboxInternalInfo> _sandboxMap = new();

    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    public SandboxService(
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration,
        ILogger<SandboxService> logger)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _httpClient = httpClientFactory.CreateClient("VPSManager");

        var gatewayUrl = configuration["VPS:GatewayUrl"]
            ?? throw new InvalidOperationException("VPS:GatewayUrl is not configured");
        _httpClient.BaseAddress = new Uri(gatewayUrl);
        _gatewayBaseUrl = gatewayUrl.TrimEnd('/');

        var apiKey = configuration["VPS:ManagerApiKey"] ?? string.Empty;
        if (!string.IsNullOrEmpty(apiKey))
            _httpClient.DefaultRequestHeaders.Add("X-Api-Key", apiKey);
    }

    // ── Public lookup for the proxy controller ───────────────────────────────

    /// <summary>
    /// Returns internal sandbox info (bridge/VNC URLs, token) if <paramref name="userId"/>
    /// owns <paramref name="sandboxId"/>.  Used by the proxy controller.
    /// </summary>
    public SandboxInternalInfo? TryGetInternalInfo(Guid userId, string sandboxId)
    {
        if (!_sandboxMap.TryGetValue(sandboxId, out var info)) return null;
        return info.OwnerId == userId ? info : null;
    }

    /// <summary>
    /// Returns internal sandbox info without ownership check.
    /// Used for VNC proxy endpoints where the iframe cannot carry a JWT.
    /// Access is gated by knowing the sandbox ID (a random UUID).
    /// </summary>
    public SandboxInternalInfo? TryGetInternalInfoById(string sandboxId)
    {
        _sandboxMap.TryGetValue(sandboxId, out var info);
        return info;
    }

    /// <summary>
    /// Like <see cref="TryGetInternalInfoById"/> but falls back to the manager API
    /// if the sandbox isn't in the local map (e.g. after backend restart).
    /// No ownership check — used for VNC endpoints that cannot carry a JWT.
    /// </summary>
    public async Task<SandboxInternalInfo?> TryGetOrRediscoverByIdAsync(string sandboxId, CancellationToken ct = default)
    {
        if (_sandboxMap.TryGetValue(sandboxId, out var existing))
            return existing;

        try
        {
            using var response = await _httpClient.GetAsync($"/sandboxes/{sandboxId}", ct);
            if (!response.IsSuccessStatusCode) return null;

            var raw = await response.Content.ReadFromJsonAsync<ManagerStatusResponse>(_jsonOptions, ct);
            if (raw is null || string.IsNullOrEmpty(raw.SandboxToken)) return null;

            var info = new SandboxInternalInfo
            {
                OwnerId = Guid.Empty,
                InternalBridgeUrl = raw.BridgeUrl,
                InternalVncUrl = raw.Url,
                SandboxToken = raw.SandboxToken,
                VncPassword = raw.VncPassword ?? "",
            };
            _sandboxMap[sandboxId] = info;
            _logger.LogInformation("Re-discovered sandbox {SandboxId} from manager (VNC path)", sandboxId);
            return info;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Re-discover a sandbox from the manager when it's missing from the in-memory map
    /// (e.g. after a backend restart). Assigns ownership to <paramref name="userId"/>.
    /// </summary>
    public async Task<SandboxInternalInfo?> TryRediscoverAsync(Guid userId, string sandboxId, CancellationToken ct = default)
    {
        if (_sandboxMap.TryGetValue(sandboxId, out var existing))
            return existing.OwnerId == userId ? existing : null;

        try
        {
            using var response = await _httpClient.GetAsync($"/sandboxes/{sandboxId}", ct);
            if (!response.IsSuccessStatusCode) return null;

            var raw = await response.Content.ReadFromJsonAsync<ManagerStatusResponse>(_jsonOptions, ct);
            if (raw is null || string.IsNullOrEmpty(raw.SandboxToken)) return null;

            var info = new SandboxInternalInfo
            {
                OwnerId = userId,
                InternalBridgeUrl = raw.BridgeUrl,
                InternalVncUrl = raw.Url,
                SandboxToken = raw.SandboxToken,
                VncPassword = raw.VncPassword ?? "",
            };
            _sandboxMap[sandboxId] = info;
            _logger.LogInformation("Re-discovered sandbox {SandboxId} from manager for user {UserId}", sandboxId, userId);
            return info;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to re-discover sandbox {SandboxId} from manager", sandboxId);
            return null;
        }
    }

    // ── ISandboxService ──────────────────────────────────────────────────────

    public async Task<SandboxCreateResult> CreateSandboxAsync(
        Guid userId,
        SandboxCreateRequest request,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Creating sandbox for user {UserId}", userId);

        var payload = BuildManagerPayload(request);

        using var response = await _httpClient.PostAsJsonAsync("/sandboxes", payload, _jsonOptions, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogError(
                "Sandbox manager POST /sandboxes failed with {StatusCode}: {Body}",
                (int)response.StatusCode,
                string.IsNullOrWhiteSpace(errorBody) ? "(empty body)" : errorBody);
            response.EnsureSuccessStatusCode();
        }

        var raw = await response.Content.ReadFromJsonAsync<ManagerCreateResponse>(_jsonOptions, cancellationToken)
                  ?? throw new InvalidOperationException("Empty response from sandbox manager");

        _sandboxMap[raw.Id] = new SandboxInternalInfo
        {
            OwnerId = userId,
            InternalBridgeUrl = raw.BridgeUrl,
            InternalVncUrl = raw.Url,
            SandboxToken = raw.SandboxToken,
            VncPassword = raw.VncPassword,
        };

        return new SandboxCreateResult
        {
            Id = raw.Id,
            Status = raw.Status,
            VncPassword = raw.VncPassword,
        };
    }

    public async Task<IReadOnlyList<SandboxListItem>> ListSandboxesAsync(
        Guid userId,
        CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.GetAsync("/sandboxes", cancellationToken);
        response.EnsureSuccessStatusCode();

        var raw = await response.Content.ReadFromJsonAsync<ManagerListResponse>(_jsonOptions, cancellationToken);
        if (raw?.Sandboxes is null) return [];

        // Re-adopt sandboxes the manager still has but we lost after a backend restart.
        // This assigns orphan sandboxes to the requesting user — acceptable for
        // single-tenant / small-team deployments where the manager is shared.
        foreach (var s in raw.Sandboxes)
        {
            if (!_sandboxMap.ContainsKey(s.Id) && !string.IsNullOrEmpty(s.SandboxToken))
            {
                _logger.LogInformation("Re-adopting orphaned sandbox {SandboxId} for user {UserId}", s.Id, userId);
                _sandboxMap[s.Id] = new SandboxInternalInfo
                {
                    OwnerId = userId,
                    InternalBridgeUrl = s.BridgeUrl,
                    InternalVncUrl = s.Url,
                    SandboxToken = s.SandboxToken,
                    VncPassword = s.VncPassword ?? "",
                };
            }
        }

        return raw.Sandboxes
            .Where(s => _sandboxMap.TryGetValue(s.Id, out var info) && info.OwnerId == userId)
            .Select(s => new SandboxListItem
            {
                Id = s.Id,
                Status = s.Status,
            })
            .ToList();
    }

    public async Task<SandboxStatusResult?> GetSandboxAsync(
        Guid userId,
        string sandboxId,
        CancellationToken cancellationToken = default)
    {
        if (!IsOwner(userId, sandboxId))
        {
            _logger.LogWarning("User {UserId} attempted to access sandbox {SandboxId} they do not own", userId, sandboxId);
            return null;
        }

        using var response = await _httpClient.GetAsync($"/sandboxes/{sandboxId}", cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
            return null;
        response.EnsureSuccessStatusCode();

        var raw = await response.Content.ReadFromJsonAsync<ManagerStatusResponse>(_jsonOptions, cancellationToken);
        if (raw is null) return null;

        return new SandboxStatusResult
        {
            Id = raw.Id,
            Status = raw.Status,
        };
    }

    public async Task<bool> DeleteSandboxAsync(
        Guid userId,
        string sandboxId,
        CancellationToken cancellationToken = default)
    {
        if (!IsOwner(userId, sandboxId))
        {
            _logger.LogWarning("User {UserId} attempted to delete sandbox {SandboxId} they do not own", userId, sandboxId);
            return false;
        }

        using var response = await _httpClient.DeleteAsync($"/sandboxes/{sandboxId}", cancellationToken);
        if (response.IsSuccessStatusCode)
        {
            _sandboxMap.TryRemove(sandboxId, out _);
            return true;
        }
        return false;
    }

    /// <inheritdoc />
    public async Task<bool> TryAssignSandboxOwnershipAsync(
        Guid userId,
        string sandboxId,
        CancellationToken cancellationToken = default)
    {
        if (IsOwner(userId, sandboxId))
            return true;

        try
        {
            using var response = await _httpClient.GetAsync($"/sandboxes/{sandboxId}", cancellationToken);
            if (!response.IsSuccessStatusCode)
                return false;

            var raw = await response.Content.ReadFromJsonAsync<ManagerStatusResponse>(_jsonOptions, cancellationToken);
            if (raw is null || string.IsNullOrEmpty(raw.SandboxToken))
                return false;

            _sandboxMap[sandboxId] = new SandboxInternalInfo
            {
                OwnerId = userId,
                InternalBridgeUrl = raw.BridgeUrl,
                InternalVncUrl = raw.Url,
                SandboxToken = raw.SandboxToken,
                VncPassword = raw.VncPassword ?? "",
            };
            _logger.LogInformation("Registered sandbox {SandboxId} for user {UserId} from manager", sandboxId, userId);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "TryAssignSandboxOwnershipAsync failed for {SandboxId}", sandboxId);
            return false;
        }
    }

    /// <inheritdoc />
    public string? GetVncPasswordIfOwnedBy(Guid userId, string sandboxId)
    {
        if (!IsOwner(userId, sandboxId)) return null;
        return _sandboxMap.TryGetValue(sandboxId, out var info) ? info.VncPassword : null;
    }

    private bool IsOwner(Guid userId, string sandboxId) =>
        _sandboxMap.TryGetValue(sandboxId, out var info) && info.OwnerId == userId;

    private static object BuildManagerPayload(SandboxCreateRequest req)
    {
        return new
        {
            resolution = req.Resolution,
            repo_url = req.RepoUrl,
            repo_name = req.RepoName,
            repo_branch = req.RepoBranch,
            repo_archive_url = req.RepoArchiveUrl,
            github_token = req.GithubToken,
            azure_devops_pat = req.AzureDevOpsPat,
            ai_config = req.AiConfig is null ? null : new
            {
                provider = req.AiConfig.Provider,
                api_key = req.AiConfig.ApiKey,
                model = req.AiConfig.Model,
                base_url = req.AiConfig.BaseUrl,
            },
            zed_settings = req.ZedSettings,
            artifact_feeds = req.ArtifactFeeds?.Select(f => new
            {
                name = f.Name,
                organization = f.Organization,
                feed_name = f.FeedName,
                project_name = f.ProjectName,
                feed_type = f.FeedType,
            }).ToList(),
            agent_rules = req.AgentRules,
            azure_identity_client_id = req.AzureIdentityClientId,
            azure_identity_client_secret = req.AzureIdentityClientSecret,
            azure_identity_tenant_id = req.AzureIdentityTenantId,
        };
    }

    // ── DTO types for deserialising manager responses ────────────────────────

    private record ManagerListResponse(
        [property: JsonPropertyName("sandboxes")] List<ManagerListItem> Sandboxes);

    private record ManagerListItem(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("url")] string Url,
        [property: JsonPropertyName("bridge_url")] string BridgeUrl,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("sandbox_token")] string? SandboxToken = null,
        [property: JsonPropertyName("vnc_password")] string? VncPassword = null);

    private record ManagerCreateResponse(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("url")] string Url,
        [property: JsonPropertyName("bridge_url")] string BridgeUrl,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("sandbox_token")] string SandboxToken,
        [property: JsonPropertyName("vnc_password")] string VncPassword);

    private record ManagerStatusResponse(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("url")] string Url,
        [property: JsonPropertyName("bridge_url")] string BridgeUrl,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("sandbox_token")] string? SandboxToken = null,
        [property: JsonPropertyName("vnc_password")] string? VncPassword = null);
}

/// <summary>Server-side sandbox credentials — never exposed to the browser.</summary>
public class SandboxInternalInfo
{
    public Guid OwnerId { get; init; }
    public string InternalBridgeUrl { get; init; } = string.Empty;
    public string InternalVncUrl { get; init; } = string.Empty;
    public string SandboxToken { get; init; } = string.Empty;
    public string VncPassword { get; init; } = string.Empty;
}
