namespace DevPilot.Application.Services;

using DevPilot.Application.DTOs;

/// <summary>
/// Service interface for interacting with GitHub API
/// Defined in Application layer, implemented in Infrastructure
/// </summary>
public interface IGitHubService
{
    /// <summary>
    /// Fetches all repositories accessible by the user with the provided access token
    /// </summary>
    System.Threading.Tasks.Task<IEnumerable<GitHubRepositoryDto>> GetRepositoriesAsync(
        string accessToken,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Fetches repositories for a specific organization
    /// </summary>
    System.Threading.Tasks.Task<IEnumerable<GitHubRepositoryDto>> GetOrganizationRepositoriesAsync(
        string accessToken,
        string organizationName,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Creates a pull request
    /// </summary>
    System.Threading.Tasks.Task<GitHubPullRequestDto> CreatePullRequestAsync(
        string accessToken,
        string owner,
        string repo,
        string head,
        string baseBranch,
        string title,
        string? body = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Gets the status of a pull request (open, closed, merged)
    /// </summary>
    System.Threading.Tasks.Task<PullRequestStatusDto> GetPullRequestStatusAsync(
        string accessToken,
        string prUrl,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Gets the head (source) branch name of a pull request from its URL.
    /// Used to clone the PR branch when continuing work on a story that already has a PR.
    /// </summary>
    System.Threading.Tasks.Task<string?> GetPullRequestHeadBranchAsync(
        string accessToken,
        string prUrl,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Gets issues and milestones from a GitHub repository
    /// </summary>
    System.Threading.Tasks.Task<GitHubIssuesHierarchyDto> GetIssuesAsync(
        string accessToken,
        string owner,
        string repo,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Gets the repository file tree (directory contents)
    /// </summary>
    System.Threading.Tasks.Task<RepositoryTreeDto> GetRepositoryTreeAsync(
        string accessToken,
        string owner,
        string repo,
        string? path = null,
        string? branch = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Gets the content of a specific file
    /// </summary>
    System.Threading.Tasks.Task<RepositoryFileContentDto> GetFileContentAsync(
        string accessToken,
        string owner,
        string repo,
        string path,
        string? branch = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Gets repository branches
    /// </summary>
    System.Threading.Tasks.Task<IEnumerable<RepositoryBranchDto>> GetBranchesAsync(
        string accessToken,
        string owner,
        string repo,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Gets pull requests from a repository
    /// </summary>
    System.Threading.Tasks.Task<IEnumerable<PullRequestDto>> GetPullRequestsAsync(
        string accessToken,
        string owner,
        string repo,
        string? state = "all",
        CancellationToken cancellationToken = default);
}

/// <summary>
/// DTO representing a created pull request
/// </summary>
public class GitHubPullRequestDto
{
    public required string Url { get; set; }
    public required int Number { get; set; }
    public required string Title { get; set; }
}

/// <summary>
/// DTO representing the status of a pull request
/// </summary>
public class PullRequestStatusDto
{
    public required string State { get; set; } // "open", "closed"
    public required bool IsMerged { get; set; }
    public string? MergedAt { get; set; }
}

/// <summary>
/// DTO representing a repository from GitHub API
/// </summary>
public class GitHubRepositoryDto
{
    public required string Name { get; set; }
    public required string FullName { get; set; }
    public required string CloneUrl { get; set; }
    public string? Description { get; set; }
    public required bool IsPrivate { get; set; }
    public required string OrganizationName { get; set; }
    public string? DefaultBranch { get; set; }
}

/// <summary>
/// DTO representing a GitHub issue
/// </summary>
public class GitHubIssueDto
{
    public required int Number { get; set; }
    public required string Title { get; set; }
    public string? Body { get; set; }
    public required string State { get; set; } // "open", "closed"
    public string? Assignee { get; set; }
    public List<string> Labels { get; set; } = new();
    public int? MilestoneNumber { get; set; }
    public string? MilestoneTitle { get; set; }
    public required string Url { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? UpdatedAt { get; set; }
    public DateTime? ClosedAt { get; set; }
    public bool IsPullRequest { get; set; }
}

/// <summary>
/// DTO representing a GitHub milestone
/// </summary>
public class GitHubMilestoneDto
{
    public required int Number { get; set; }
    public required string Title { get; set; }
    public string? Description { get; set; }
    public required string State { get; set; } // "open", "closed"
    public int OpenIssues { get; set; }
    public int ClosedIssues { get; set; }
    public DateTime? DueOn { get; set; }
    public DateTime CreatedAt { get; set; }
    public string? Url { get; set; }
}

/// <summary>
/// DTO for hierarchical GitHub issues response (organized by milestones)
/// </summary>
public class GitHubIssuesHierarchyDto
{
    public List<GitHubMilestoneDto> Milestones { get; set; } = new();
    public List<GitHubIssueDto> Issues { get; set; } = new();
    /// <summary>
    /// Issues not assigned to any milestone
    /// </summary>
    public List<GitHubIssueDto> UnassignedIssues { get; set; } = new();
}

/// <summary>
/// DTO representing a file or directory in the repository tree
/// </summary>
public class RepositoryTreeItemDto
{
    public required string Name { get; set; }
    public required string Path { get; set; }
    public required string Type { get; set; } // "file", "dir", "symlink", "submodule"
    public long? Size { get; set; } // Only for files
    public string? Sha { get; set; }
    public string? Url { get; set; }
}

/// <summary>
/// DTO representing the repository tree (directory listing)
/// </summary>
public class RepositoryTreeDto
{
    public required string Path { get; set; }
    public required string Branch { get; set; }
    public List<RepositoryTreeItemDto> Items { get; set; } = new();
    public string? Readme { get; set; } // README content if present in this directory
}

/// <summary>
/// DTO representing file content
/// </summary>
public class RepositoryFileContentDto
{
    public required string Name { get; set; }
    public required string Path { get; set; }
    public required string Content { get; set; }
    public required string Encoding { get; set; } // "base64", "utf-8"
    public long Size { get; set; }
    public string? Sha { get; set; }
    public string? Language { get; set; } // Detected language for syntax highlighting
    public bool IsBinary { get; set; }
    public bool IsTruncated { get; set; }
}

/// <summary>
/// DTO representing a repository branch
/// </summary>
public class RepositoryBranchDto
{
    public required string Name { get; set; }
    public required string Sha { get; set; }
    public bool IsDefault { get; set; }
    public bool IsProtected { get; set; }
}

/// <summary>
/// DTO representing a pull request
/// </summary>
public class PullRequestDto
{
    public required int Number { get; set; }
    public required string Title { get; set; }
    public string? Description { get; set; }
    public required string State { get; set; } // "open", "closed", "merged"
    public required string SourceBranch { get; set; }
    public required string TargetBranch { get; set; }
    public required string Author { get; set; }
    public string? AuthorAvatarUrl { get; set; }
    public required string Url { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? UpdatedAt { get; set; }
    public DateTime? MergedAt { get; set; }
    public DateTime? ClosedAt { get; set; }
    public bool IsMerged { get; set; }
    public bool IsDraft { get; set; }
    public int Comments { get; set; }
    public int Commits { get; set; }
    public int Additions { get; set; }
    public int Deletions { get; set; }
    public int ChangedFiles { get; set; }
    public List<string> Labels { get; set; } = new();
    public List<string> Reviewers { get; set; } = new();
}
