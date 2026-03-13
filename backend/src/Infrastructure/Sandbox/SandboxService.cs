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
/// </summary>
public class SandboxService : ISandboxService
{
    private readonly HttpClient _httpClient;
    private readonly IConfiguration _configuration;
    private readonly ILogger<SandboxService> _logger;
    private readonly string _publicIp;

    // sandboxId → ownerUserId  (in-memory; cleared on process restart — acceptable since
    // the manager's own state is also in-memory and lost on restart)
    private static readonly ConcurrentDictionary<string, Guid> _ownershipMap = new();

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
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _httpClient = httpClientFactory.CreateClient("VPSManager");

        var gatewayUrl = _configuration["VPS:GatewayUrl"]
            ?? throw new InvalidOperationException("VPS:GatewayUrl is not configured");
        _httpClient.BaseAddress = new Uri(gatewayUrl);

        var apiKey = _configuration["VPS:ManagerApiKey"] ?? string.Empty;
        if (!string.IsNullOrEmpty(apiKey))
            _httpClient.DefaultRequestHeaders.Add("X-Api-Key", apiKey);

        _publicIp = _configuration["VPS:PublicIp"] ?? "localhost";

        // When the frontend is served over HTTPS, direct http://<ip>:<port> sandbox URLs
        // cause mixed-content browser errors.  Set VPS:HttpsProxyBase (e.g. https://flexagent.online)
        // and the backend will return nginx proxy URLs instead:
        //   VNC   → {HttpsProxyBase}/sandbox-vnc/{port}/vnc.html
        //   Bridge→ {HttpsProxyBase}/sandbox-bridge/{bridgePort}
        _httpsProxyBase = (_configuration["VPS:HttpsProxyBase"] ?? string.Empty).TrimEnd('/');
    }

    private readonly string _httpsProxyBase;

    private string BuildVncUrl(int port)
        => string.IsNullOrEmpty(_httpsProxyBase)
            ? $"http://{_publicIp}:{port}/vnc.html"
            : $"{_httpsProxyBase}/sandbox-vnc/{port}/vnc.html";

    private string BuildBridgeUrl(int bridgePort)
        => string.IsNullOrEmpty(_httpsProxyBase)
            ? $"http://{_publicIp}:{bridgePort}"
            : $"{_httpsProxyBase}/sandbox-bridge/{bridgePort}";

    public async Task<SandboxCreateResult> CreateSandboxAsync(
        Guid userId,
        SandboxCreateRequest request,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Creating sandbox for user {UserId}", userId);

        var payload = BuildManagerPayload(request);

        using var response = await _httpClient.PostAsJsonAsync("/sandboxes", payload, _jsonOptions, cancellationToken);
        response.EnsureSuccessStatusCode();

        var raw = await response.Content.ReadFromJsonAsync<ManagerCreateResponse>(_jsonOptions, cancellationToken)
                  ?? throw new InvalidOperationException("Empty response from sandbox manager");

        _ownershipMap[raw.Id] = userId;

        return new SandboxCreateResult
        {
            Id = raw.Id,
            Port = raw.Port,
            BridgePort = raw.BridgePort,
            Url = BuildVncUrl(raw.Port),
            BridgeUrl = BuildBridgeUrl(raw.BridgePort),
            Status = raw.Status,
            SandboxToken = raw.SandboxToken,
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

        return raw.Sandboxes
            .Where(s => _ownershipMap.TryGetValue(s.Id, out var owner) && owner == userId)
            .Select(s => new SandboxListItem
            {
                Id = s.Id,
                Port = s.Port,
                BridgePort = s.BridgePort,
                Url = BuildVncUrl(s.Port),
                BridgeUrl = BuildBridgeUrl(s.BridgePort),
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
            Port = raw.Port,
            BridgePort = raw.BridgePort,
            Url = BuildVncUrl(raw.Port),
            BridgeUrl = BuildBridgeUrl(raw.BridgePort),
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
            _ownershipMap.TryRemove(sandboxId, out _);
            return true;
        }
        return false;
    }

    private bool IsOwner(Guid userId, string sandboxId) =>
        _ownershipMap.TryGetValue(sandboxId, out var owner) && owner == userId;

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
        };
    }

    // DTO types for deserialising manager responses
    private record ManagerListResponse(
        [property: JsonPropertyName("sandboxes")] List<ManagerListItem> Sandboxes);

    private record ManagerListItem(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("port")] int Port,
        [property: JsonPropertyName("bridge_port")] int BridgePort,
        [property: JsonPropertyName("status")] string Status);

    private record ManagerCreateResponse(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("port")] int Port,
        [property: JsonPropertyName("bridge_port")] int BridgePort,
        [property: JsonPropertyName("url")] string Url,
        [property: JsonPropertyName("bridge_url")] string BridgeUrl,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("sandbox_token")] string SandboxToken,
        [property: JsonPropertyName("vnc_password")] string VncPassword);

    private record ManagerStatusResponse(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("port")] int Port,
        [property: JsonPropertyName("bridge_port")] int BridgePort,
        [property: JsonPropertyName("status")] string Status);
}
