namespace DevPilot.Infrastructure.Zed;

using DevPilot.Application.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using System.Net.Http.Json;
using System.Text.Json;

/// <summary>
/// Implementation of IZedSessionService for managing Zed sessions on VPS
/// Communicates with VPS gateway to create/destroy containers
/// </summary>
public class ZedSessionService : IZedSessionService
{
    private readonly IConfiguration _configuration;
    private readonly ILogger<ZedSessionService> _logger;
    private readonly HttpClient _httpClient;

    public ZedSessionService(
        IConfiguration configuration,
        ILogger<ZedSessionService> logger,
        IHttpClientFactory httpClientFactory)
    {
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _httpClient = httpClientFactory?.CreateClient("VPSGateway") 
            ?? throw new ArgumentNullException(nameof(httpClientFactory));

        // Configure base URL for VPS gateway
        var vpsBaseUrl = _configuration["VPS:GatewayUrl"] 
            ?? throw new InvalidOperationException("VPS:GatewayUrl not configured");
        _httpClient.BaseAddress = new Uri(vpsBaseUrl);
    }

    public async System.Threading.Tasks.Task<ZedSessionInfo> CreateSessionAsync(
        Guid userId,
        CancellationToken cancellationToken = default)
    {
        try
        {
            _logger.LogInformation("Creating Zed session for user {UserId}", userId);

            var request = new CreateSessionRequest
            {
                UserId = userId.ToString(),
                SessionTimeoutMinutes = _configuration.GetValue<int>("VPS:SessionTimeoutMinutes", 60)
            };

            var response = await _httpClient.PostAsJsonAsync("/api/sessions", request, cancellationToken);
            response.EnsureSuccessStatusCode();

            var sessionInfo = await response.Content.ReadFromJsonAsync<ZedSessionInfo>(cancellationToken: cancellationToken);

            if (sessionInfo == null)
            {
                throw new InvalidOperationException("Failed to parse session info from VPS gateway");
            }

            _logger.LogInformation("Successfully created Zed session {SessionId} at {Endpoint}", 
                sessionInfo.SessionId, sessionInfo.EndpointUrl);

            return sessionInfo;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create Zed session for user {UserId}", userId);
            throw;
        }
    }

    public async System.Threading.Tasks.Task DestroySessionAsync(
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        try
        {
            _logger.LogInformation("Destroying Zed session {SessionId}", sessionId);

            var response = await _httpClient.DeleteAsync($"/api/sessions/{sessionId}", cancellationToken);
            response.EnsureSuccessStatusCode();

            _logger.LogInformation("Successfully destroyed Zed session {SessionId}", sessionId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to destroy Zed session {SessionId}", sessionId);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<ZedSessionStatus> GetSessionStatusAsync(
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var response = await _httpClient.GetAsync($"/api/sessions/{sessionId}/status", cancellationToken);
            response.EnsureSuccessStatusCode();

            var status = await response.Content.ReadFromJsonAsync<ZedSessionStatus>(cancellationToken: cancellationToken);

            if (status == null)
            {
                throw new InvalidOperationException("Failed to parse session status from VPS gateway");
            }

            return status;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get status for Zed session {SessionId}", sessionId);
            throw;
        }
    }

    /// <summary>
    /// Request model for creating a session
    /// </summary>
    private class CreateSessionRequest
    {
        public string UserId { get; set; } = string.Empty;
        public int SessionTimeoutMinutes { get; set; } = 60;
    }
}
