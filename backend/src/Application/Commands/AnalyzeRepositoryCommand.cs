namespace DevPilot.Application.Commands;

using DevPilot.Application.Services;
using MediatR;

/// <summary>
/// Command to analyze a repository and generate work items (Epics, Features, User Stories, Tasks)
/// </summary>
public class AnalyzeRepositoryCommand : IRequest<RepositoryAnalysisResult>
{
    public Guid RepositoryId { get; }
    public string? RepositoryContent { get; set; } // Optional: if not provided, will be fetched

    public AnalyzeRepositoryCommand(Guid repositoryId, string? repositoryContent = null)
    {
        RepositoryId = repositoryId;
        RepositoryContent = repositoryContent;
    }
}
