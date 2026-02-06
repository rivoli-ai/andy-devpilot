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
    /// Creates a pull request and optionally links work items to it
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
        IReadOnlyList<int>? workItemIds = null,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);

    /// <summary>
    /// Gets teams in a project
    /// </summary>
    System.Threading.Tasks.Task<IEnumerable<AzureDevOpsTeamDto>> GetTeamsAsync(
        string accessToken,
        string organization,
        string project,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);

    /// <summary>
    /// Gets allowed states for a work item type (e.g. Epic, Feature, User Story).
    /// </summary>
    System.Threading.Tasks.Task<IReadOnlyList<AzureDevOpsWorkItemStateDto>> GetWorkItemTypeStatesAsync(
        string accessToken,
        string organization,
        string project,
        string workItemType,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);

    /// <summary>
    /// Gets work item types for the given work item IDs (batch).
    /// </summary>
    System.Threading.Tasks.Task<IReadOnlyDictionary<int, string>> GetWorkItemTypesByIdsAsync(
        string accessToken,
        string organization,
        string project,
        IReadOnlyList<int> workItemIds,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);

    /// <summary>
    /// Updates a work item in Azure DevOps using JSON Patch
    /// </summary>
    System.Threading.Tasks.Task UpdateWorkItemAsync(
        string accessToken,
        string organization,
        string project,
        int workItemId,
        IReadOnlyList<AzureDevOpsWorkItemPatchOperation> patches,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false);

    /// <summary>
    /// Gets work items (Epics, Features, User Stories, Tasks) from an Azure DevOps project
    /// Optionally filtered by team's area path
    /// </summary>
    System.Threading.Tasks.Task<AzureDevOpsWorkItemsHierarchyDto> GetWorkItemsAsync(
        string accessToken,
        string organization,
        string project,
        string? teamId = null,
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
/// DTO representing an Azure DevOps team
/// </summary>
public class AzureDevOpsTeamDto
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public string? Description { get; set; }
    public string? ProjectName { get; set; }
    public string? ProjectId { get; set; }
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
/// DTO representing an Azure DevOps work item state (name and category)
/// </summary>
public class AzureDevOpsWorkItemStateDto
{
    public required string Name { get; set; }
    public required string Category { get; set; }
}

/// <summary>
/// JSON Patch operation for updating Azure DevOps work item fields
/// </summary>
public class AzureDevOpsWorkItemPatchOperation
{
    public required string Op { get; set; } // "add", "replace", etc.
    public required string Path { get; set; } // e.g. "/fields/System.Title"
    public object? Value { get; set; }
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
