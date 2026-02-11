namespace DevPilot.Application.Services;

/// <summary>
/// Service interface for AI-powered repository analysis
/// Defined in Application layer, implemented in Infrastructure
/// </summary>
public interface IAnalysisService
{
    /// <summary>
    /// Analyzes a repository and generates structured work items (Epics, Features, User Stories, Tasks)
    /// Uses deterministic prompts and returns structured JSON
    /// </summary>
    System.Threading.Tasks.Task<RepositoryAnalysisResult> AnalyzeRepositoryAsync(
        string repositoryContent,
        string repositoryName,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Result of repository analysis containing generated work items
/// Structured JSON output from AI
/// </summary>
public class RepositoryAnalysisResult
{
    public required string Reasoning { get; set; }
    public required List<EpicAnalysis> Epics { get; set; }
    public required Metadata Metadata { get; set; }
}

/// <summary>
/// Epic analysis with features, user stories, and tasks
/// </summary>
public class EpicAnalysis
{
    public required string Title { get; set; }
    public required string Description { get; set; }
    public required List<FeatureAnalysis> Features { get; set; }
}

/// <summary>
/// Feature analysis with user stories
/// </summary>
public class FeatureAnalysis
{
    public required string Title { get; set; }
    public required string Description { get; set; }
    public required List<UserStoryAnalysis> UserStories { get; set; }
}

/// <summary>
/// User story analysis with tasks
/// </summary>
public class UserStoryAnalysis
{
    public required string Title { get; set; }
    public required string Description { get; set; }
    public required string AcceptanceCriteria { get; set; }
    public required List<TaskAnalysis> Tasks { get; set; }
}

/// <summary>
/// Task analysis with complexity assessment
/// </summary>
public class TaskAnalysis
{
    public required string Title { get; set; }
    public required string Description { get; set; }
    public required string Complexity { get; set; } // "Simple", "Medium", "Complex"
}

/// <summary>
/// Metadata about the analysis
/// Includes reasoning and analysis details
/// </summary>
public class Metadata
{
    public required string AnalysisTimestamp { get; set; }
    public required string Model { get; set; }
    public required string Reasoning { get; set; }
}
