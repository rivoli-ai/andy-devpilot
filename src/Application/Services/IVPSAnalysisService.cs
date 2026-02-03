namespace DevPilot.Application.Services;

/// <summary>
/// High-level service that orchestrates VPS-based repository analysis
/// This service coordinates Zed sessions, ACP communication, and analysis execution
/// </summary>
public interface IVPSAnalysisService
{
    /// <summary>
    /// Analyzes a repository using VPS/Zed infrastructure
    /// 1. Creates a Zed session
    /// 2. Clones the repository
    /// 3. Analyzes repository content
    /// 4. Generates backlog items
    /// 5. Cleans up session
    /// 6. Returns analysis results
    /// </summary>
    System.Threading.Tasks.Task<RepositoryAnalysisResult> AnalyzeRepositoryViaVPSAsync(
        Guid repositoryId,
        string cloneUrl,
        string repositoryName,
        Guid userId,
        CancellationToken cancellationToken = default);
}
