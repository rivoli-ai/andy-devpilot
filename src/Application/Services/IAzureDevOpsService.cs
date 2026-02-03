namespace DevPilot.Application.Services;

/// <summary>
/// Service interface for interacting with Azure DevOps API
/// Defined in Application layer, implemented in Infrastructure
/// </summary>
public interface IAzureDevOpsService
{
    /// <summary>
    /// Fetches all repositories accessible by the user with the provided access token
    /// </summary>
    System.Threading.Tasks.Task<IEnumerable<AzureDevOpsRepositoryDto>> GetRepositoriesAsync(
        string accessToken,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Fetches repositories for a specific organization/project
    /// </summary>
    System.Threading.Tasks.Task<IEnumerable<AzureDevOpsRepositoryDto>> GetProjectRepositoriesAsync(
        string accessToken,
        string organization,
        string project,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);

    /// <summary>
    /// Gets organizations/accounts accessible by the user
    /// </summary>
    System.Threading.Tasks.Task<IEnumerable<AzureDevOpsOrganizationDto>> GetOrganizationsAsync(
        string accessToken,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Gets projects in an organization
    /// </summary>
    System.Threading.Tasks.Task<IEnumerable<AzureDevOpsProjectDto>> GetProjectsAsync(
        string accessToken,
        string organization,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);

    /// <summary>
    /// Creates a pull request
    /// </summary>
    System.Threading.Tasks.Task<AzureDevOpsPullRequestDto> CreatePullRequestAsync(
        string accessToken,
        string organization,
        string project,
        string repositoryId,
        string sourceBranch,
        string targetBranch,
        string title,
        string? description = null,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);

    /// <summary>
    /// Gets work items (Epics, Features, User Stories, Tasks) from an Azure DevOps project
    /// </summary>
    System.Threading.Tasks.Task<AzureDevOpsWorkItemsHierarchyDto> GetWorkItemsAsync(
        string accessToken,
        string organization,
        string project,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);

    /// <summary>
    /// Gets the repository file tree (directory contents)
    /// </summary>
    System.Threading.Tasks.Task<RepositoryTreeDto> GetRepositoryTreeAsync(
        string accessToken,
        string organization,
        string project,
        string repositoryId,
        string? path = null,
        string? branch = null,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);

    /// <summary>
    /// Gets the content of a specific file
    /// </summary>
    System.Threading.Tasks.Task<RepositoryFileContentDto> GetFileContentAsync(
        string accessToken,
        string organization,
        string project,
        string repositoryId,
        string path,
        string? branch = null,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);

    /// <summary>
    /// Gets repository branches
    /// </summary>
    System.Threading.Tasks.Task<IEnumerable<RepositoryBranchDto>> GetBranchesAsync(
        string accessToken,
        string organization,
        string project,
        string repositoryId,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);

    /// <summary>
    /// Gets pull requests from a repository
    /// </summary>
    System.Threading.Tasks.Task<IEnumerable<PullRequestDto>> GetPullRequestsAsync(
        string accessToken,
        string organization,
        string project,
        string repositoryId,
        string? status = "all",
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);
}

/// <summary>
/// DTO representing an Azure DevOps organization/account
/// </summary>
public class AzureDevOpsOrganizationDto
{
    public required string AccountId { get; set; }
    public required string AccountName { get; set; }
    public required string AccountUri { get; set; }
}

/// <summary>
/// DTO representing an Azure DevOps project
/// </summary>
public class AzureDevOpsProjectDto
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public string? Description { get; set; }
    public required string State { get; set; }
}

/// <summary>
/// DTO representing a repository from Azure DevOps API
/// </summary>
public class AzureDevOpsRepositoryDto
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public required string RemoteUrl { get; set; }
    public required string WebUrl { get; set; }
    public required string ProjectName { get; set; }
    public required string OrganizationName { get; set; }
    public string? DefaultBranch { get; set; }
    public bool IsDisabled { get; set; }
}

/// <summary>
/// DTO representing a created pull request in Azure DevOps
/// </summary>
public class AzureDevOpsPullRequestDto
{
    public required int PullRequestId { get; set; }
    public required string Url { get; set; }
    public required string Title { get; set; }
    public required string Status { get; set; }
}

/// <summary>
/// DTO representing an Azure DevOps work item (Epic, Feature, User Story, Task)
/// </summary>
public class AzureDevOpsWorkItemDto
{
    public required int Id { get; set; }
    public required string Title { get; set; }
    public string? Description { get; set; }
    public required string WorkItemType { get; set; } // Epic, Feature, User Story, Task, Bug, etc.
    public required string State { get; set; }
    public string? AssignedTo { get; set; }
    public int? Priority { get; set; }
    public double? StoryPoints { get; set; }
    public string? AcceptanceCriteria { get; set; }
    public int? ParentId { get; set; }
    public string? AreaPath { get; set; }
    public string? IterationPath { get; set; }
    public List<int> ChildIds { get; set; } = new();
    public string? Url { get; set; }
    public DateTime? CreatedDate { get; set; }
    public DateTime? ChangedDate { get; set; }
}

/// <summary>
/// DTO for hierarchical work items response
/// </summary>
public class AzureDevOpsWorkItemsHierarchyDto
{
    public List<AzureDevOpsWorkItemDto> Epics { get; set; } = new();
    public List<AzureDevOpsWorkItemDto> Features { get; set; } = new();
    public List<AzureDevOpsWorkItemDto> UserStories { get; set; } = new();
    public List<AzureDevOpsWorkItemDto> Tasks { get; set; } = new();
    public List<AzureDevOpsWorkItemDto> Bugs { get; set; } = new();
}
