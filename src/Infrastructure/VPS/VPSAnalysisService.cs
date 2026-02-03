namespace DevPilot.Infrastructure.VPS;

using DevPilot.Application.Services;
using Microsoft.Extensions.Logging;

/// <summary>
/// Orchestrates repository analysis via VPS/Zed infrastructure
/// Coordinates session creation, repository cloning, analysis execution, and cleanup
/// </summary>
public class VPSAnalysisService : IVPSAnalysisService
{
    private readonly IZedSessionService _zedSessionService;
    private readonly IACPClient _acpClient;
    private readonly ILogger<VPSAnalysisService> _logger;

    public VPSAnalysisService(
        IZedSessionService zedSessionService,
        IACPClient acpClient,
        ILogger<VPSAnalysisService> logger)
    {
        _zedSessionService = zedSessionService ?? throw new ArgumentNullException(nameof(zedSessionService));
        _acpClient = acpClient ?? throw new ArgumentNullException(nameof(acpClient));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<RepositoryAnalysisResult> AnalyzeRepositoryViaVPSAsync(
        Guid repositoryId,
        string cloneUrl,
        string repositoryName,
        Guid userId,
        CancellationToken cancellationToken = default)
    {
        ZedSessionInfo? sessionInfo = null;

        try
        {
            _logger.LogInformation("Starting VPS analysis for repository {RepositoryName} (ID: {RepositoryId})", 
                repositoryName, repositoryId);

            // Step 1: Create Zed session on VPS
            _logger.LogInformation("Creating Zed session for user {UserId}", userId);
            sessionInfo = await _zedSessionService.CreateSessionAsync(userId, cancellationToken);

            // Step 2: Connect ACP client to the session
            _logger.LogInformation("Connecting ACP client to session {SessionId}", sessionInfo.SessionId);
            await _acpClient.ConnectAsync(
                sessionInfo.SessionId,
                sessionInfo.EndpointUrl,
                sessionInfo.AuthToken,
                cancellationToken);

            // Step 3: Initialize session in Zed container
            _logger.LogInformation("Initializing session {SessionId} in Zed container", sessionInfo.SessionId);
            var initResponse = await _acpClient.InitSessionAsync(sessionInfo.SessionId, cancellationToken);
            if (!initResponse.Success)
            {
                throw new InvalidOperationException($"Failed to initialize session: {initResponse.Error}");
            }

            // Step 4: Clone repository into container
            _logger.LogInformation("Cloning repository {CloneUrl} into container", cloneUrl);
            var cloneResponse = await _acpClient.CloneRepositoryAsync(cloneUrl, null, cancellationToken);
            if (!cloneResponse.Success)
            {
                throw new InvalidOperationException($"Failed to clone repository: {cloneResponse.Error}");
            }

            // Step 5: Analyze repository and generate backlog
            _logger.LogInformation("Analyzing repository {RepositoryName} and generating backlog", repositoryName);
            var analysisResult = await _acpClient.AnalyzeRepositoryAsync(repositoryName, cancellationToken);

            _logger.LogInformation("Successfully completed VPS analysis for repository {RepositoryName}. Generated {EpicCount} epics", 
                repositoryName, analysisResult.Epics.Count);

            return analysisResult;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during VPS analysis for repository {RepositoryName} (ID: {RepositoryId})", 
                repositoryName, repositoryId);
            throw;
        }
        finally
        {
            // Step 6: Cleanup - close session and destroy container
            if (sessionInfo != null)
            {
                try
                {
                    _logger.LogInformation("Cleaning up session {SessionId}", sessionInfo.SessionId);
                    await _acpClient.CloseSessionAsync(cancellationToken);
                    await _zedSessionService.DestroySessionAsync(sessionInfo.SessionId, cancellationToken);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Error during session cleanup for {SessionId}", sessionInfo.SessionId);
                    // Don't throw - cleanup errors shouldn't fail the entire operation
                }
            }
        }
    }
}
