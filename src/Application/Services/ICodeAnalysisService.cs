namespace DevPilot.Application.Services;

/// <summary>
/// Service interface for AI-powered code analysis
/// Supports both global repository analysis and per-file explanations
/// </summary>
public interface ICodeAnalysisService
{
    /// <summary>
    /// Analyzes a repository's code structure, architecture, and provides recommendations
    /// Uses sandbox to clone and analyze the full repository
    /// </summary>
    System.Threading.Tasks.Task<CodeAnalysisResult> AnalyzeRepositoryCodeAsync(
        Guid repositoryId,
        string? branch = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Analyzes a specific file and provides explanation, key functions, and suggestions
    /// Uses direct AI chat completion with user's AI settings (no sandbox needed)
    /// </summary>
    System.Threading.Tasks.Task<FileAnalysisResult> AnalyzeFileAsync(
        Guid repositoryId,
        Guid userId,
        string filePath,
        string fileContent,
        string? branch = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Gets stored code analysis for a repository (from database)
    /// </summary>
    System.Threading.Tasks.Task<CodeAnalysisResult?> GetStoredAnalysisAsync(
        Guid repositoryId,
        string? branch = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Gets stored file analysis (from database)
    /// </summary>
    System.Threading.Tasks.Task<FileAnalysisResult?> GetStoredFileAnalysisAsync(
        Guid repositoryId,
        string filePath,
        string? branch = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Deletes stored analysis for a repository (for refresh)
    /// </summary>
    System.Threading.Tasks.Task DeleteAnalysisAsync(
        Guid repositoryId,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Saves analysis results from frontend (frontend-driven sandbox flow)
    /// </summary>
    System.Threading.Tasks.Task<CodeAnalysisResult> SaveAnalysisResultAsync(
        Guid repositoryId,
        string? branch,
        string summary,
        string? architecture,
        string? keyComponents,
        string? dependencies,
        string? recommendations,
        string? model,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Result of global code analysis
/// </summary>
public class CodeAnalysisResult
{
    public Guid Id { get; set; }
    public Guid RepositoryId { get; set; }
    public required string Branch { get; set; }
    public required string Summary { get; set; }
    public string? Architecture { get; set; }
    public string? KeyComponents { get; set; }
    public string? Dependencies { get; set; }
    public string? Recommendations { get; set; }
    public DateTime AnalyzedAt { get; set; }
    public string? Model { get; set; }
}

/// <summary>
/// Result of file analysis
/// </summary>
public class FileAnalysisResult
{
    public Guid Id { get; set; }
    public Guid RepositoryId { get; set; }
    public required string FilePath { get; set; }
    public required string Branch { get; set; }
    public required string Explanation { get; set; }
    public string? KeyFunctions { get; set; }
    public string? Complexity { get; set; }
    public string? Suggestions { get; set; }
    public DateTime AnalyzedAt { get; set; }
    public string? Model { get; set; }
}
