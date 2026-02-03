namespace DevPilot.Application.Commands;

using DevPilot.Application.Services;
using MediatR;

/// <summary>
/// Command to persist analysis results (Epics, Features, User Stories, Tasks) to the database
/// </summary>
public class SaveAnalysisResultsCommand : IRequest<int>
{
    public Guid RepositoryId { get; }
    public RepositoryAnalysisResult AnalysisResult { get; }

    public SaveAnalysisResultsCommand(Guid repositoryId, RepositoryAnalysisResult analysisResult)
    {
        RepositoryId = repositoryId;
        AnalysisResult = analysisResult ?? throw new ArgumentNullException(nameof(analysisResult));
    }
}
