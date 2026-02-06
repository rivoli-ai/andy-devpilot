namespace DevPilot.API.Controllers;

using System.Security.Claims;
using DevPilot.Application.Commands;
using DevPilot.Application.Queries;
using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Request body for creating a pull request
/// </summary>
public class CreatePullRequestRequest
{
    public required string HeadBranch { get; set; }
    public required string BaseBranch { get; set; }
    public required string Title { get; set; }
    public string? Body { get; set; }
    /// <summary>Azure DevOps work item IDs to link to the PR (e.g. [190])</summary>
    public List<int>? WorkItemIds { get; set; }
}

/// <summary>
/// Controller for managing repositories
/// Follows Clean Architecture - no business logic, only delegates to Application layer
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class RepositoriesController : ControllerBase
{
    private readonly IMediator _mediator;
    private readonly IUserRepository _userRepository;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly ILinkedProviderRepository _linkedProviderRepository;
    private readonly IGitHubService _gitHubService;
    private readonly IAzureDevOpsService _azureDevOpsService;
    private readonly ILogger<RepositoriesController> _logger;

    public RepositoriesController(
        IMediator mediator,
        IUserRepository userRepository,
        IRepositoryRepository repositoryRepository,
        ILinkedProviderRepository linkedProviderRepository,
        IGitHubService gitHubService,
        IAzureDevOpsService azureDevOpsService,
        ILogger<RepositoriesController> logger)
    {
        _mediator = mediator ?? throw new ArgumentNullException(nameof(mediator));
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _linkedProviderRepository = linkedProviderRepository ?? throw new ArgumentNullException(nameof(linkedProviderRepository));
        _gitHubService = gitHubService ?? throw new ArgumentNullException(nameof(gitHubService));
        _azureDevOpsService = azureDevOpsService ?? throw new ArgumentNullException(nameof(azureDevOpsService));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Get repositories for the current authenticated user.
    /// Supports pagination and search via query params.
    /// </summary>
    /// <param name="search">Optional search term (matches repository name, full name, or organization)</param>
    /// <param name="page">Page number (1-based)</param>
    /// <param name="pageSize">Items per page (1-100)</param>
    [HttpGet]
    [Authorize]
    public async Task<IActionResult> GetRepositories(
        [FromQuery] string? search = null,
        [FromQuery] int? page = null,
        [FromQuery] int? pageSize = null,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        if (page.HasValue || pageSize.HasValue || !string.IsNullOrWhiteSpace(search))
        {
            var paginatedQuery = new GetRepositoriesPaginatedQuery(
                userId,
                search,
                page ?? 1,
                pageSize ?? 20);
            var result = await _mediator.Send(paginatedQuery, cancellationToken);
            return Ok(result);
        }

        var query = new GetRepositoriesByUserIdQuery(userId);
        var repositories = await _mediator.Send(query, cancellationToken);
        return Ok(repositories);
    }

    /// <summary>
    /// Sync repositories from GitHub for the current authenticated user
    /// Fetches repositories from GitHub and stores them in the database
    /// Uses linked provider access token (with fallback to legacy field)
    /// </summary>
    [HttpPost("sync/github")]
    [Authorize]
    public async Task<IActionResult> SyncRepositoriesFromGitHub(CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        // Try to get GitHub access token from linked providers first
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
        string? accessToken = linkedProvider?.AccessToken;

        // Fallback to legacy field if not found in linked providers
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            if (user == null)
            {
                return Unauthorized("User not found");
            }
            accessToken = user.GitHubAccessToken;
        }

        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return BadRequest(new { message = "GitHub is not connected. Please link your GitHub account first.", provider = "GitHub" });
        }

        var command = new SyncRepositoriesFromGitHubCommand(userId, accessToken);
        var repositories = await _mediator.Send(command, cancellationToken);

        return Ok(repositories);
    }

    /// <summary>
    /// Sync repositories from Azure DevOps for the current authenticated user
    /// Fetches repositories from Azure DevOps and stores them in the database
    /// </summary>
    [HttpPost("sync/azure-devops")]
    [Authorize]
    public async Task<IActionResult> SyncRepositoriesFromAzureDevOps([FromBody] AzureDevOpsSyncRequest? request, CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        // Get user for potential token storage
        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        if (user == null)
        {
            return Unauthorized("User not found");
        }

        // Get Azure DevOps access token from linked providers
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.AzureDevOps, cancellationToken);
        
        // PRIORITY: 1. User's stored PAT from Settings, 2. Request PAT, 3. OAuth token
        bool hasStoredPat = !string.IsNullOrWhiteSpace(user.AzureDevOpsAccessToken);
        bool hasRequestPat = !string.IsNullOrWhiteSpace(request?.PersonalAccessToken);
        bool hasOAuthToken = linkedProvider != null && !string.IsNullOrWhiteSpace(linkedProvider.AccessToken);
        
        if (!hasStoredPat && !hasRequestPat && !hasOAuthToken)
        {
            return BadRequest(new { message = "Azure DevOps is not connected. Please configure your PAT in Settings or link your Azure DevOps account.", provider = "AzureDevOps" });
        }

        try
        {
            _logger.LogInformation("Starting Azure DevOps repository sync for user {UserId}", userId);
            
            // Determine which token to use: Stored PAT > Request PAT > OAuth token
            string accessToken;
            bool usingPat = false;
            
            if (hasStoredPat)
            {
                // Use stored PAT from Settings - convert to Basic auth format
                accessToken = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
                usingPat = true;
                _logger.LogInformation("Using stored PAT from Settings for Azure DevOps authentication");
            }
            else if (hasRequestPat)
            {
                // Use PAT from request - convert to Basic auth format for Azure DevOps
                accessToken = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes($":{request!.PersonalAccessToken}"));
                usingPat = true;
                _logger.LogInformation("Using Personal Access Token from request for Azure DevOps authentication");
                
                // Store PAT for later use (code browsing, pull requests, etc.)
                user.UpdateAzureDevOpsToken(request.PersonalAccessToken);
                await _userRepository.UpdateAsync(user, cancellationToken);
                _logger.LogInformation("Stored Azure DevOps PAT for user {UserId}", userId);
            }
            else if (hasOAuthToken)
            {
                accessToken = linkedProvider!.AccessToken;
                _logger.LogInformation("Using OAuth token for Azure DevOps authentication");
            }
            else
            {
                return BadRequest(new { message = "No authentication available. Please configure your PAT in Settings or link your Azure DevOps account." });
            }
            
            List<Application.Services.AzureDevOpsRepositoryDto> reposList;
            
            // Use organization from: 1. Request, 2. User's stored settings
            var organizationName = !string.IsNullOrWhiteSpace(request?.OrganizationName) 
                ? request.OrganizationName 
                : user.AzureDevOpsOrganization;
            
            // If organization name is available, fetch directly from that organization
            if (!string.IsNullOrWhiteSpace(organizationName))
            {
                _logger.LogInformation("Fetching repositories from organization: {Organization}", organizationName);
                var allRepos = new List<Application.Services.AzureDevOpsRepositoryDto>();
                
                // Get all projects in the organization using the appropriate token
                var projects = await _azureDevOpsService.GetProjectsAsync(accessToken, organizationName, cancellationToken, usingPat);
                _logger.LogInformation("Found {Count} projects in organization {Organization}", projects.Count(), organizationName);
                
                foreach (var project in projects)
                {
                    var projectRepos = await _azureDevOpsService.GetProjectRepositoriesAsync(
                        accessToken,
                        organizationName,
                        project.Name,
                        cancellationToken,
                        usingPat);
                    allRepos.AddRange(projectRepos);
                }
                
                reposList = allRepos;
            }
            else
            {
                // Try automatic organization discovery (may not work with Entra ID tokens)
                var azureDevOpsRepos = await _azureDevOpsService.GetRepositoriesAsync(accessToken, cancellationToken);
                reposList = azureDevOpsRepos.ToList();
            }
            
            _logger.LogInformation("Found {Count} repositories from Azure DevOps", reposList.Count);
            
            if (reposList.Count == 0)
            {
                _logger.LogWarning("No repositories found in Azure DevOps");
                return Ok(new { 
                    message = "No repositories found. Try specifying your organization name (e.g., 'myorg' from dev.azure.com/myorg).",
                    requiresOrganization = true,
                    repositories = new List<object>()
                });
            }
            
            // Convert to our repository format and save
            var savedRepos = new List<object>();
            foreach (var adoRepo in reposList)
            {
                // Check if repository already exists for THIS USER
                var existingRepo = await _repositoryRepository.GetByFullNameProviderAndUserIdAsync(
                    $"{adoRepo.OrganizationName}/{adoRepo.ProjectName}/{adoRepo.Name}", 
                    "AzureDevOps",
                    userId,
                    cancellationToken);

                if (existingRepo == null)
                {
                    var newRepo = new Repository(
                        name: adoRepo.Name,
                        fullName: $"{adoRepo.OrganizationName}/{adoRepo.ProjectName}/{adoRepo.Name}",
                        cloneUrl: adoRepo.RemoteUrl,
                        provider: "AzureDevOps",
                        organizationName: adoRepo.OrganizationName,
                        userId: userId,
                        description: null,
                        isPrivate: true, // Azure DevOps repos are typically private
                        defaultBranch: adoRepo.DefaultBranch ?? "main"
                    );
                    await _repositoryRepository.AddAsync(newRepo, cancellationToken);
                    savedRepos.Add(new
                    {
                        id = newRepo.Id,
                        name = newRepo.Name,
                        fullName = newRepo.FullName,
                        provider = newRepo.Provider,
                        organizationName = newRepo.OrganizationName,
                        defaultBranch = newRepo.DefaultBranch
                    });
                }
                else
                {
                    savedRepos.Add(new
                    {
                        id = existingRepo.Id,
                        name = existingRepo.Name,
                        fullName = existingRepo.FullName,
                        provider = existingRepo.Provider,
                        organizationName = existingRepo.OrganizationName,
                        defaultBranch = existingRepo.DefaultBranch
                    });
                }
            }

            return Ok(savedRepos);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to sync repositories from Azure DevOps for user {UserId}", userId);
            return BadRequest(new { message = $"Failed to sync from Azure DevOps: {ex.Message}" });
        }
    }

    /// <summary>
    /// Get available sync sources for the current user
    /// Returns which providers (GitHub, Azure DevOps) are linked
    /// </summary>
    [HttpGet("sync/sources")]
    [Authorize]
    public async Task<IActionResult> GetAvailableSyncSources(CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var linkedProviders = await _linkedProviderRepository.GetByUserIdAsync(userId, cancellationToken);
        
        // Also check legacy/stored credentials (PAT in Settings)
        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        var hasLegacyGitHub = !string.IsNullOrWhiteSpace(user?.GitHubAccessToken);
        var hasStoredAzurePat = !string.IsNullOrWhiteSpace(user?.AzureDevOpsAccessToken);

        var sources = new List<object>();

        // Check GitHub
        var hasGitHub = linkedProviders.Any(p => p.Provider == ProviderTypes.GitHub) || hasLegacyGitHub;
        if (hasGitHub)
        {
            var githubProvider = linkedProviders.FirstOrDefault(p => p.Provider == ProviderTypes.GitHub);
            sources.Add(new
            {
                provider = "GitHub",
                isLinked = true,
                username = githubProvider?.ProviderUsername ?? user?.GitHubUsername
            });
        }
        else
        {
            sources.Add(new { provider = "GitHub", isLinked = false, username = (string?)null });
        }

        // Check Azure DevOps (OAuth link OR stored PAT in Settings)
        var azureDevOpsProvider = linkedProviders.FirstOrDefault(p => p.Provider == ProviderTypes.AzureDevOps);
        var hasAzureDevOps = azureDevOpsProvider != null || hasStoredAzurePat;
        if (hasAzureDevOps)
        {
            sources.Add(new
            {
                provider = "AzureDevOps",
                isLinked = true,
                username = azureDevOpsProvider?.ProviderUsername ?? user?.AzureDevOpsOrganization ?? "PAT"
            });
        }
        else
        {
            sources.Add(new { provider = "AzureDevOps", isLinked = false, username = (string?)null });
        }

        return Ok(sources);
    }

    /// <summary>
    /// Get Azure DevOps projects for the configured organization
    /// </summary>
    [HttpGet("azure-devops/projects")]
    [Authorize]
    public async Task<IActionResult> GetAzureDevOpsProjects(CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        try
        {
            // Get user to access stored settings
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            
            if (user == null || string.IsNullOrEmpty(user.AzureDevOpsOrganization))
            {
                return BadRequest(new { message = "Azure DevOps organization is not configured. Please set it in Settings." });
            }

            string accessToken;
            bool useBasicAuth = false;

            // Use stored PAT if available
            if (!string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
            {
                var credentials = Convert.ToBase64String(
                    System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
                accessToken = credentials;
                useBasicAuth = true;
                _logger.LogInformation("Using stored PAT for fetching Azure DevOps projects");
            }
            else
            {
                // Fall back to OAuth token
                var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(
                    userId, ProviderTypes.AzureDevOps, cancellationToken);

                if (linkedProvider == null)
                {
                    return BadRequest(new { 
                        message = "Azure DevOps is not configured. Please add your PAT in Settings.",
                        requiresPat = true 
                    });
                }

                accessToken = linkedProvider.AccessToken;
            }

            var projects = await _azureDevOpsService.GetProjectsAsync(
                accessToken, 
                user.AzureDevOpsOrganization, 
                cancellationToken, 
                useBasicAuth);

            return Ok(projects);
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "Azure DevOps authentication failed for projects");
            return BadRequest(new { message = ex.Message });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching Azure DevOps projects");
            return StatusCode(500, new { message = "Failed to fetch projects" });
        }
    }

    /// <summary>
    /// Request body for fetching Azure DevOps work items
    /// </summary>
    public class AzureDevOpsWorkItemsRequest
    {
        public string? OrganizationName { get; set; }
        public required string ProjectName { get; set; }
        public string? TeamId { get; set; }
        public string? PersonalAccessToken { get; set; }
    }

    /// <summary>
    /// Get Azure DevOps teams for a project
    /// </summary>
    [HttpGet("azure-devops/projects/{projectName}/teams")]
    [Authorize]
    public async Task<IActionResult> GetAzureDevOpsTeams(string projectName, CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        try
        {
            // Get user to access stored settings
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            
            if (user == null || string.IsNullOrEmpty(user.AzureDevOpsOrganization))
            {
                return BadRequest(new { message = "Azure DevOps organization is not configured. Please set it in Settings." });
            }

            string accessToken;
            bool useBasicAuth = false;

            // Use stored PAT if available
            if (!string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
            {
                var credentials = Convert.ToBase64String(
                    System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
                accessToken = credentials;
                useBasicAuth = true;
                _logger.LogInformation("Using stored PAT for fetching Azure DevOps teams");
            }
            else
            {
                // Fall back to OAuth token
                var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(
                    userId, ProviderTypes.AzureDevOps, cancellationToken);

                if (linkedProvider == null)
                {
                    return BadRequest(new { 
                        message = "Azure DevOps is not configured. Please add your PAT in Settings.",
                        requiresPat = true 
                    });
                }

                accessToken = linkedProvider.AccessToken;
            }

            var teams = await _azureDevOpsService.GetTeamsAsync(
                accessToken, 
                user.AzureDevOpsOrganization,
                projectName,
                cancellationToken, 
                useBasicAuth);

            return Ok(teams);
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "Azure DevOps authentication failed for teams");
            return BadRequest(new { message = ex.Message });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching Azure DevOps teams for project {Project}", projectName);
            return StatusCode(500, new { message = "Failed to fetch teams" });
        }
    }

    /// <summary>
    /// Get work items (Epics, Features, User Stories) from Azure DevOps project
    /// </summary>
    [HttpPost("azure-devops/work-items")]
    [Authorize]
    public async Task<IActionResult> GetAzureDevOpsWorkItems(
        [FromBody] AzureDevOpsWorkItemsRequest request,
        CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        try
        {
            // Get user to access stored settings
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            
            string accessToken;
            bool useBasicAuth = false;

            // Priority: 1. User's stored PAT, 2. Request PAT, 3. OAuth token
            if (user != null && !string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
            {
                // Use stored PAT from settings
                var credentials = Convert.ToBase64String(
                    System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
                accessToken = credentials;
                useBasicAuth = true;
                _logger.LogInformation("Using stored PAT for Azure DevOps work items");
            }
            else if (!string.IsNullOrEmpty(request.PersonalAccessToken))
            {
                // PAT authentication uses Basic auth with base64 encoded ":PAT"
                var credentials = Convert.ToBase64String(
                    System.Text.Encoding.ASCII.GetBytes($":{request.PersonalAccessToken}"));
                accessToken = credentials;
                useBasicAuth = true;
                _logger.LogInformation("Using request PAT for Azure DevOps work items");
            }
            else
            {
                // Get OAuth token from linked provider
                var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(
                    userId, ProviderTypes.AzureDevOps, cancellationToken);

                if (linkedProvider == null)
                {
                    return BadRequest(new { 
                        message = "Azure DevOps is not configured. Please add your PAT in Settings.",
                        requiresPat = true 
                    });
                }

                accessToken = linkedProvider.AccessToken;
            }

            // Get organization: 1. From request, 2. From user's stored settings
            var organizationName = request.OrganizationName;
            if (string.IsNullOrEmpty(organizationName) && user != null)
            {
                organizationName = user.AzureDevOpsOrganization;
            }
            
            if (string.IsNullOrEmpty(organizationName))
            {
                return BadRequest(new { message = "Organization name is required. Please configure it in Settings." });
            }

            var workItems = await _azureDevOpsService.GetWorkItemsAsync(
                accessToken,
                organizationName,
                request.ProjectName,
                request.TeamId,
                cancellationToken,
                useBasicAuth);

            return Ok(workItems);
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "Azure DevOps authentication failed for work items");
            return BadRequest(new { 
                message = ex.Message, 
                requiresPat = true 
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch work items from Azure DevOps for user {UserId}", userId);
            return BadRequest(new { message = $"Failed to fetch work items: {ex.Message}" });
        }
    }

    /// <summary>
    /// Request body for fetching GitHub issues
    /// </summary>
    public class GitHubIssuesRequest
    {
        public required string Owner { get; set; }
        public required string Repo { get; set; }
    }

    /// <summary>
    /// Get issues and milestones from a GitHub repository
    /// </summary>
    [HttpPost("github/issues")]
    [Authorize]
    public async Task<IActionResult> GetGitHubIssues(
        [FromBody] GitHubIssuesRequest request,
        CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        try
        {
            // Get GitHub access token from linked provider or legacy field
            var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(
                userId, ProviderTypes.GitHub, cancellationToken);

            string? accessToken = linkedProvider?.AccessToken;

            // Fallback to legacy GitHubAccessToken field
            if (string.IsNullOrEmpty(accessToken))
            {
                var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
                accessToken = user?.GitHubAccessToken;
            }

            if (string.IsNullOrEmpty(accessToken))
            {
                return BadRequest(new { 
                    message = "GitHub is not linked. Please link your GitHub account first."
                });
            }

            var issues = await _gitHubService.GetIssuesAsync(
                accessToken,
                request.Owner,
                request.Repo,
                cancellationToken);

            return Ok(issues);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch issues from GitHub for user {UserId}", userId);
            return BadRequest(new { message = $"Failed to fetch issues: {ex.Message}" });
        }
    }

    /// <summary>
    /// Analyze a repository and generate work items (Epics, Features, User Stories, Tasks)
    /// Uses AI to analyze the repository structure and generate structured work items
    /// </summary>
    /// <param name="repositoryId">The ID of the repository to analyze</param>
    /// <param name="request">Request body with optional repository content and save flag</param>
    [HttpPost("{repositoryId}/analyze")]
    public async Task<IActionResult> AnalyzeRepository(
        Guid repositoryId,
        [FromBody] AnalyzeRepositoryRequest? request,
        CancellationToken cancellationToken)
    {
        var command = new AnalyzeRepositoryCommand(repositoryId, request?.RepositoryContent);
        var analysisResult = await _mediator.Send(command, cancellationToken);

        // Optionally save the analysis results to the database
        if (request?.SaveResults == true)
        {
            var saveCommand = new SaveAnalysisResultsCommand(repositoryId, analysisResult);
            var itemsSaved = await _mediator.Send(saveCommand, cancellationToken);
            
            return Ok(new 
            { 
                analysis = analysisResult,
                itemsSaved = itemsSaved,
                message = $"Analysis completed and {itemsSaved} work items saved to database"
            });
        }

        return Ok(analysisResult);
    }

    /// <summary>
    /// Save analysis results (Epics, Features, User Stories, Tasks) to the database
    /// </summary>
    /// <param name="repositoryId">The ID of the repository</param>
    /// <param name="analysisResult">The analysis result to save</param>
    [HttpPost("{repositoryId}/analyze/save")]
    public async Task<IActionResult> SaveAnalysisResults(
        Guid repositoryId,
        [FromBody] RepositoryAnalysisResult analysisResult,
        CancellationToken cancellationToken)
    {
        var command = new SaveAnalysisResultsCommand(repositoryId, analysisResult);
        var itemsSaved = await _mediator.Send(command, cancellationToken);

        return Ok(new 
        { 
            itemsSaved = itemsSaved,
            message = $"Successfully saved {itemsSaved} work items to database"
        });
    }

    /// <summary>
    /// Create a pull request for a repository
    /// Uses the authenticated user's linked provider token
    /// </summary>
    [HttpPost("{repositoryId}/pull-requests")]
    [Authorize]
    public async Task<IActionResult> CreatePullRequest(
        Guid repositoryId,
        [FromBody] CreatePullRequestRequest request,
        CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var repository = await _repositoryRepository.GetByIdAsync(repositoryId, cancellationToken);
        if (repository == null)
        {
            return NotFound("Repository not found");
        }

        // Handle based on provider
        if (repository.Provider == "GitHub")
        {
            return await CreateGitHubPullRequest(userId, repository, request, cancellationToken);
        }
        else if (repository.Provider == "AzureDevOps")
        {
            return await CreateAzureDevOpsPullRequest(userId, repository, request, cancellationToken);
        }
        else
        {
            return BadRequest($"Unsupported provider: {repository.Provider}");
        }
    }

    private async Task<IActionResult> CreateGitHubPullRequest(
        Guid userId,
        Repository repository,
        CreatePullRequestRequest request,
        CancellationToken cancellationToken)
    {
        // Get GitHub token from linked providers first, then fallback to legacy
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
        string? accessToken = linkedProvider?.AccessToken;

        if (string.IsNullOrWhiteSpace(accessToken))
        {
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            accessToken = user?.GitHubAccessToken;
        }

        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return BadRequest("GitHub is not connected. Please link your GitHub account first.");
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 2)
        {
            return BadRequest("Invalid repository full name");
        }

        var owner = parts[0];
        var repo = parts[1];

        try
        {
            var pr = await _gitHubService.CreatePullRequestAsync(
                accessToken,
                owner,
                repo,
                request.HeadBranch,
                request.BaseBranch,
                request.Title,
                request.Body,
                cancellationToken);

            return Ok(pr);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create GitHub pull request for {RepositoryId}", repository.Id);
            return BadRequest(ex.Message);
        }
    }

    private async Task<IActionResult> CreateAzureDevOpsPullRequest(
        Guid userId,
        Repository repository,
        CreatePullRequestRequest request,
        CancellationToken cancellationToken)
    {
        // Use the helper method that properly handles PAT vs OAuth
        var (accessToken, useBasicAuth) = await GetAzureDevOpsAccessToken(userId, cancellationToken);
        
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return BadRequest("Azure DevOps is not connected. Please link your Azure DevOps account or configure a PAT in Settings.");
        }

        // Parse Azure DevOps full name format: organization/project/repo
        var parts = repository.FullName.Split('/');
        if (parts.Length != 3)
        {
            return BadRequest("Invalid Azure DevOps repository full name format. Expected: organization/project/repo");
        }

        var organization = parts[0];
        var project = parts[1];
        var repoName = parts[2];

        try
        {
            var pr = await _azureDevOpsService.CreatePullRequestAsync(
                accessToken,
                organization,
                project,
                repoName,
                request.HeadBranch,
                request.BaseBranch,
                request.Title,
                request.Body,
                request.WorkItemIds,
                cancellationToken,
                useBasicAuth);

            return Ok(new
            {
                Url = pr.Url,
                Number = pr.PullRequestId,
                Title = pr.Title
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create Azure DevOps pull request for {RepositoryId}", repository.Id);
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Request body for repository analysis
    /// </summary>
    public class AnalyzeRepositoryRequest
    {
        public string? RepositoryContent { get; set; }
        public bool SaveResults { get; set; } = false;
    }

    /// <summary>
    /// Request body for Azure DevOps sync
    /// </summary>
    public class AzureDevOpsSyncRequest
    {
        /// <summary>
        /// Optional: Azure DevOps organization name (e.g., 'myorg' from dev.azure.com/myorg)
        /// If not provided, will try to auto-discover organizations (may not work with Entra ID)
        /// </summary>
        public string? OrganizationName { get; set; }
        
        /// <summary>
        /// Optional: Personal Access Token (PAT) for Azure DevOps authentication
        /// If provided, will use PAT instead of OAuth token
        /// </summary>
        public string? PersonalAccessToken { get; set; }
    }

    /// <summary>
    /// Get repository file tree (directory listing)
    /// </summary>
    [HttpGet("{repositoryId}/tree")]
    [Authorize]
    public async Task<IActionResult> GetRepositoryTree(
        Guid repositoryId,
        [FromQuery] string? path = null,
        [FromQuery] string? branch = null,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var repository = await _repositoryRepository.GetByIdAsync(repositoryId, cancellationToken);
        if (repository == null)
        {
            return NotFound("Repository not found");
        }

        try
        {
            if (repository.Provider == "GitHub")
            {
                return await GetGitHubTree(userId, repository, path, branch, cancellationToken);
            }
            else if (repository.Provider == "AzureDevOps")
            {
                return await GetAzureDevOpsTree(userId, repository, path, branch, cancellationToken);
            }
            else
            {
                return BadRequest($"Unsupported provider: {repository.Provider}");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get repository tree for {RepositoryId}", repositoryId);
            return BadRequest(new { message = ex.Message });
        }
    }

    /// <summary>
    /// Get file content from repository
    /// </summary>
    [HttpGet("{repositoryId}/file")]
    [Authorize]
    public async Task<IActionResult> GetFileContent(
        Guid repositoryId,
        [FromQuery] string path,
        [FromQuery] string? branch = null,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var repository = await _repositoryRepository.GetByIdAsync(repositoryId, cancellationToken);
        if (repository == null)
        {
            return NotFound("Repository not found");
        }

        if (string.IsNullOrEmpty(path))
        {
            return BadRequest("File path is required");
        }

        try
        {
            if (repository.Provider == "GitHub")
            {
                return await GetGitHubFileContent(userId, repository, path, branch, cancellationToken);
            }
            else if (repository.Provider == "AzureDevOps")
            {
                return await GetAzureDevOpsFileContent(userId, repository, path, branch, cancellationToken);
            }
            else
            {
                return BadRequest($"Unsupported provider: {repository.Provider}");
            }
        }
        catch (FileNotFoundException)
        {
            return NotFound($"File not found: {path}");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get file content for {RepositoryId}/{Path}", repositoryId, path);
            return BadRequest(new { message = ex.Message });
        }
    }

    /// <summary>
    /// Get repository branches
    /// </summary>
    [HttpGet("{repositoryId}/branches")]
    [Authorize]
    public async Task<IActionResult> GetBranches(
        Guid repositoryId,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var repository = await _repositoryRepository.GetByIdAsync(repositoryId, cancellationToken);
        if (repository == null)
        {
            return NotFound("Repository not found");
        }

        try
        {
            if (repository.Provider == "GitHub")
            {
                return await GetGitHubBranches(userId, repository, cancellationToken);
            }
            else if (repository.Provider == "AzureDevOps")
            {
                return await GetAzureDevOpsBranches(userId, repository, cancellationToken);
            }
            else
            {
                return BadRequest($"Unsupported provider: {repository.Provider}");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get branches for {RepositoryId}", repositoryId);
            return BadRequest(new { message = ex.Message });
        }
    }

    private async Task<IActionResult> GetGitHubTree(Guid userId, Repository repository, string? path, string? branch, CancellationToken cancellationToken)
    {
        var accessToken = await GetGitHubAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "GitHub is not connected. Please link your GitHub account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 2)
        {
            return BadRequest("Invalid repository full name");
        }

        var tree = await _gitHubService.GetRepositoryTreeAsync(accessToken, parts[0], parts[1], path, branch, cancellationToken);
        return Ok(tree);
    }

    private async Task<IActionResult> GetAzureDevOpsTree(Guid userId, Repository repository, string? path, string? branch, CancellationToken cancellationToken)
    {
        var (accessToken, useBasicAuth) = await GetAzureDevOpsAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "Azure DevOps is not connected. Please link your Azure DevOps account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 3)
        {
            return BadRequest("Invalid Azure DevOps repository full name format. Expected: organization/project/repo");
        }

        var tree = await _azureDevOpsService.GetRepositoryTreeAsync(
            accessToken, parts[0], parts[1], parts[2], path, branch, cancellationToken, useBasicAuth);
        return Ok(tree);
    }

    private async Task<IActionResult> GetGitHubFileContent(Guid userId, Repository repository, string path, string? branch, CancellationToken cancellationToken)
    {
        var accessToken = await GetGitHubAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "GitHub is not connected. Please link your GitHub account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 2)
        {
            return BadRequest("Invalid repository full name");
        }

        var content = await _gitHubService.GetFileContentAsync(accessToken, parts[0], parts[1], path, branch, cancellationToken);
        return Ok(content);
    }

    private async Task<IActionResult> GetAzureDevOpsFileContent(Guid userId, Repository repository, string path, string? branch, CancellationToken cancellationToken)
    {
        var (accessToken, useBasicAuth) = await GetAzureDevOpsAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "Azure DevOps is not connected. Please link your Azure DevOps account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 3)
        {
            return BadRequest("Invalid Azure DevOps repository full name format. Expected: organization/project/repo");
        }

        var content = await _azureDevOpsService.GetFileContentAsync(
            accessToken, parts[0], parts[1], parts[2], path, branch, cancellationToken, useBasicAuth);
        return Ok(content);
    }

    private async Task<IActionResult> GetGitHubBranches(Guid userId, Repository repository, CancellationToken cancellationToken)
    {
        var accessToken = await GetGitHubAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "GitHub is not connected. Please link your GitHub account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 2)
        {
            return BadRequest("Invalid repository full name");
        }

        var branches = await _gitHubService.GetBranchesAsync(accessToken, parts[0], parts[1], cancellationToken);
        return Ok(branches);
    }

    private async Task<IActionResult> GetAzureDevOpsBranches(Guid userId, Repository repository, CancellationToken cancellationToken)
    {
        var (accessToken, useBasicAuth) = await GetAzureDevOpsAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "Azure DevOps is not connected. Please link your Azure DevOps account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 3)
        {
            return BadRequest("Invalid Azure DevOps repository full name format. Expected: organization/project/repo");
        }

        var branches = await _azureDevOpsService.GetBranchesAsync(
            accessToken, parts[0], parts[1], parts[2], cancellationToken, useBasicAuth);
        return Ok(branches);
    }

    private async Task<string?> GetGitHubAccessToken(Guid userId, CancellationToken cancellationToken)
    {
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
        if (!string.IsNullOrEmpty(linkedProvider?.AccessToken))
        {
            return linkedProvider.AccessToken;
        }

        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        return user?.GitHubAccessToken;
    }

    private async Task<(string? accessToken, bool useBasicAuth)> GetAzureDevOpsAccessToken(Guid userId, CancellationToken cancellationToken)
    {
        _logger.LogInformation("Getting Azure DevOps access token for user {UserId}", userId);
        
        // PRIORITY: Use PAT if user has configured one (PAT has better code access permissions)
        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        _logger.LogInformation("User {UserId} has PAT: {HasPat}, Organization: {Org}", 
            userId, 
            !string.IsNullOrEmpty(user?.AzureDevOpsAccessToken),
            user?.AzureDevOpsOrganization ?? "null");
            
        if (user != null && !string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
        {
            // PAT needs to be base64 encoded with ":PAT" format for Basic auth
            var encodedPat = Convert.ToBase64String(
                System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
            _logger.LogInformation("Using stored PAT for user {UserId}", userId);
            return (encodedPat, true);
        }

        // Fall back to OAuth token from LinkedProvider
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.AzureDevOps, cancellationToken);
        if (linkedProvider != null && !string.IsNullOrEmpty(linkedProvider.AccessToken))
        {
            _logger.LogInformation("Using OAuth token from LinkedProvider for user {UserId}", userId);
            return (linkedProvider.AccessToken, false);
        }

        _logger.LogWarning("No Azure DevOps token found for user {UserId}", userId);
        return (null, false);
    }

    /// <summary>
    /// Get pull requests for a repository
    /// </summary>
    [HttpGet("{repositoryId}/pull-requests")]
    [Authorize]
    public async Task<IActionResult> GetPullRequests(
        Guid repositoryId,
        [FromQuery] string? state = "all",
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var repository = await _repositoryRepository.GetByIdAsync(repositoryId, cancellationToken);
        if (repository == null)
        {
            return NotFound("Repository not found");
        }

        try
        {
            if (repository.Provider == "GitHub")
            {
                return await GetGitHubPullRequests(userId, repository, state, cancellationToken);
            }
            else if (repository.Provider == "AzureDevOps")
            {
                return await GetAzureDevOpsPullRequests(userId, repository, state, cancellationToken);
            }
            else
            {
                return BadRequest($"Unsupported provider: {repository.Provider}");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get pull requests for {RepositoryId}", repositoryId);
            return BadRequest(new { message = ex.Message });
        }
    }

    private async Task<IActionResult> GetGitHubPullRequests(Guid userId, Repository repository, string? state, CancellationToken cancellationToken)
    {
        var accessToken = await GetGitHubAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "GitHub is not connected. Please link your GitHub account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 2)
        {
            return BadRequest("Invalid repository full name");
        }

        var pullRequests = await _gitHubService.GetPullRequestsAsync(accessToken, parts[0], parts[1], state, cancellationToken);
        return Ok(pullRequests);
    }

    private async Task<IActionResult> GetAzureDevOpsPullRequests(Guid userId, Repository repository, string? state, CancellationToken cancellationToken)
    {
        var (accessToken, useBasicAuth) = await GetAzureDevOpsAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "Azure DevOps is not connected. Please link your Azure DevOps account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 3)
        {
            return BadRequest("Invalid Azure DevOps repository full name format. Expected: organization/project/repo");
        }

        var pullRequests = await _azureDevOpsService.GetPullRequestsAsync(
            accessToken, parts[0], parts[1], parts[2], state, cancellationToken, useBasicAuth);
        return Ok(pullRequests);
    }

    /// <summary>
    /// Get the authenticated clone URL for a repository (with PAT embedded for private repos)
    /// </summary>
    [HttpGet("{repositoryId}/clone-url")]
    [Authorize]
    public async Task<IActionResult> GetAuthenticatedCloneUrl(Guid repositoryId, CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized();

        var repository = await _repositoryRepository.GetByIdAsync(repositoryId, cancellationToken);
        if (repository == null)
            return NotFound("Repository not found");

        if (repository.UserId != userId)
            return Forbid();

        var cloneUrl = repository.CloneUrl;
        
        // For Azure DevOps, embed PAT in URL
        if (repository.Provider == ProviderTypes.AzureDevOps)
        {
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            if (user != null && !string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
            {
                // Azure DevOps clone URL format with PAT: https://{PAT}@dev.azure.com/...
                // Original URL: https://dev.azure.com/{org}/{project}/_git/{repo}
                if (cloneUrl.StartsWith("https://dev.azure.com/"))
                {
                    cloneUrl = cloneUrl.Replace("https://dev.azure.com/", $"https://{user.AzureDevOpsAccessToken}@dev.azure.com/");
                    _logger.LogInformation("Created authenticated clone URL for Azure DevOps repository {RepoId}", repositoryId);
                }
                // Alternative format: https://{org}@dev.azure.com/{org}/{project}/_git/{repo}
                else if (cloneUrl.Contains("@dev.azure.com/"))
                {
                    // Replace the existing token/org prefix with PAT
                    var atIndex = cloneUrl.IndexOf("@dev.azure.com/");
                    cloneUrl = $"https://{user.AzureDevOpsAccessToken}{cloneUrl.Substring(cloneUrl.IndexOf("@dev.azure.com/"))}";
                    _logger.LogInformation("Created authenticated clone URL for Azure DevOps repository {RepoId} (alternate format)", repositoryId);
                }
            }
            else
            {
                _logger.LogWarning("No Azure DevOps PAT found for user {UserId}, clone may fail for private repos", userId);
            }
        }
        // For GitHub, embed token in URL
        else if (repository.Provider == ProviderTypes.GitHub)
        {
            var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
            if (linkedProvider != null && !string.IsNullOrEmpty(linkedProvider.AccessToken))
            {
                // GitHub clone URL format with token: https://{token}@github.com/...
                if (cloneUrl.StartsWith("https://github.com/"))
                {
                    cloneUrl = cloneUrl.Replace("https://github.com/", $"https://{linkedProvider.AccessToken}@github.com/");
                    _logger.LogInformation("Created authenticated clone URL for GitHub repository {RepoId}", repositoryId);
                }
            }
        }

        return Ok(new { cloneUrl });
    }
}
