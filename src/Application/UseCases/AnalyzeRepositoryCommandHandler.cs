namespace DevPilot.Application.UseCases;

using DevPilot.Application.Commands;
using DevPilot.Application.Services;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

/// <summary>
/// Handler for AnalyzeRepositoryCommand
/// Fetches repository details, prepares content summary, and uses AI to generate work items
/// </summary>
public class AnalyzeRepositoryCommandHandler : IRequestHandler<AnalyzeRepositoryCommand, RepositoryAnalysisResult>
{
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IAnalysisService _analysisService;
    private readonly IVPSAnalysisService? _vpsAnalysisService;
    private readonly ILogger<AnalyzeRepositoryCommandHandler> _logger;

    public AnalyzeRepositoryCommandHandler(
        IRepositoryRepository repositoryRepository,
        IAnalysisService analysisService,
        ILogger<AnalyzeRepositoryCommandHandler> logger)
        : this(repositoryRepository, analysisService, null, logger)
    {
    }

    // Constructor overload for when VPS service is available
    public AnalyzeRepositoryCommandHandler(
        IRepositoryRepository repositoryRepository,
        IAnalysisService analysisService,
        IVPSAnalysisService? vpsAnalysisService,
        ILogger<AnalyzeRepositoryCommandHandler> logger)
    {
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _analysisService = analysisService ?? throw new ArgumentNullException(nameof(analysisService));
        _vpsAnalysisService = vpsAnalysisService;
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<RepositoryAnalysisResult> Handle(
        AnalyzeRepositoryCommand request,
        CancellationToken cancellationToken)
    {
        // Fetch repository from database
        var repository = await _repositoryRepository.GetByIdAsync(request.RepositoryId, cancellationToken);

        if (repository == null)
        {
            throw new InvalidOperationException($"Repository with ID {request.RepositoryId} not found");
        }

        _logger.LogInformation("Analyzing repository {RepositoryName} (ID: {RepositoryId})", 
            repository.FullName, repository.Id);

        // Use VPS analysis if service is available, otherwise fallback to direct AI analysis
        RepositoryAnalysisResult analysisResult;

        if (_vpsAnalysisService != null)
        {
            // Use VPS/Zed infrastructure for analysis
            _logger.LogInformation("Using VPS/Zed infrastructure for repository analysis");
            analysisResult = await _vpsAnalysisService.AnalyzeRepositoryViaVPSAsync(
                repository.Id,
                repository.CloneUrl,
                repository.FullName,
                repository.UserId,
                cancellationToken);
        }
        else
        {
            // Fallback to direct AI analysis (current behavior)
            _logger.LogInformation("Using direct AI analysis (VPS disabled)");
            var repositoryContent = request.RepositoryContent ?? BuildRepositorySummary(repository);
            analysisResult = await _analysisService.AnalyzeRepositoryAsync(
                repositoryContent,
                repository.FullName,
                cancellationToken);
        }

        _logger.LogInformation("Successfully analyzed repository {RepositoryName}. Generated {EpicCount} epics", 
            repository.FullName, analysisResult.Epics.Count);

        return analysisResult;
    }

    /// <summary>
    /// Builds a repository summary from metadata
    /// In a full implementation, this would fetch actual repository content from GitHub
    /// </summary>
    private string BuildRepositorySummary(Domain.Entities.Repository repository)
    {
        return $@"Repository: {repository.FullName}
Description: {repository.Description ?? "No description"}
Provider: {repository.Provider}
Organization: {repository.OrganizationName}
Default Branch: {repository.DefaultBranch ?? "main"}
Visibility: {(repository.IsPrivate ? "Private" : "Public")}
Clone URL: {repository.CloneUrl}

Note: This is a summary based on repository metadata. For detailed analysis, 
fetch actual repository structure, files, and code from the Git provider.";
    }
}
