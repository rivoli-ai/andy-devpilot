namespace DevPilot.Application.UseCases;

using DevPilot.Application.Commands;
using DevPilot.Application.Services;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

/// <summary>
/// Handler for AnalyzeRepositoryCommand
/// Fetches repository details, prepares content summary, and uses AI to generate work items.
/// Also persists a repository-level code analysis so GET analysis returns data.
/// </summary>
public class AnalyzeRepositoryCommandHandler : IRequestHandler<AnalyzeRepositoryCommand, RepositoryAnalysisResult>
{
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IAnalysisService _analysisService;
    private readonly ICodeAnalysisService _codeAnalysisService;
    private readonly IVPSAnalysisService? _vpsAnalysisService;
    private readonly ILogger<AnalyzeRepositoryCommandHandler> _logger;

    public AnalyzeRepositoryCommandHandler(
        IRepositoryRepository repositoryRepository,
        IAnalysisService analysisService,
        ICodeAnalysisService codeAnalysisService,
        ILogger<AnalyzeRepositoryCommandHandler> logger)
        : this(repositoryRepository, analysisService, codeAnalysisService, null, logger)
    {
    }

    // Constructor overload for when VPS service is available
    public AnalyzeRepositoryCommandHandler(
        IRepositoryRepository repositoryRepository,
        IAnalysisService analysisService,
        ICodeAnalysisService codeAnalysisService,
        IVPSAnalysisService? vpsAnalysisService,
        ILogger<AnalyzeRepositoryCommandHandler> logger)
    {
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _analysisService = analysisService ?? throw new ArgumentNullException(nameof(analysisService));
        _codeAnalysisService = codeAnalysisService ?? throw new ArgumentNullException(nameof(codeAnalysisService));
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
            // Fallback to direct AI analysis using repository's linked LLM
            _logger.LogInformation("Using direct AI analysis (VPS disabled)");
            var repositoryContent = request.RepositoryContent ?? BuildRepositorySummary(repository);
            analysisResult = await _analysisService.AnalyzeRepositoryAsync(
                repository.UserId,
                repository.Id,
                repositoryContent,
                repository.FullName,
                cancellationToken);
        }

        _logger.LogInformation("Successfully analyzed repository {RepositoryName}. Generated {EpicCount} epics", 
            repository.FullName, analysisResult.Epics.Count);

        // Persist repository-level code analysis so GET .../analysis returns data
        var branch = repository.DefaultBranch ?? "main";
        var (summary, architecture, keyComponents) = BuildCodeAnalysisFromResult(analysisResult);
        try
        {
            await _codeAnalysisService.SaveAnalysisResultAsync(
                repository.Id,
                branch,
                summary,
                architecture,
                keyComponents,
                dependencies: null,
                recommendations: null,
                analysisResult.Metadata?.Model,
                cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to save repository-level code analysis for {RepositoryId}", repository.Id);
        }

        return analysisResult;
    }

    private static (string Summary, string? Architecture, string? KeyComponents) BuildCodeAnalysisFromResult(RepositoryAnalysisResult result)
    {
        var epicTitles = result.Epics?.Select(e => e.Title).Where(t => !string.IsNullOrWhiteSpace(t)).ToList() ?? new List<string>();
        var summary = !string.IsNullOrWhiteSpace(result.Reasoning)
            ? result.Reasoning
            : (epicTitles.Count > 0
                ? $"Repository analysis produced {epicTitles.Count} epic(s): " + string.Join(", ", epicTitles) + "."
                : "Repository analysis completed.");
        var featureTitles = result.Epics?
            .SelectMany(e => e.Features ?? new List<FeatureAnalysis>())
            .Select(f => f.Title)
            .Where(t => !string.IsNullOrWhiteSpace(t))
            .Distinct()
            .ToList() ?? new List<string>();
        var architecture = epicTitles.Count > 0 ? string.Join("\n", epicTitles) : null;
        var keyComponents = featureTitles.Count > 0 ? string.Join("\n", featureTitles) : architecture;
        return (summary, architecture, keyComponents);
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
