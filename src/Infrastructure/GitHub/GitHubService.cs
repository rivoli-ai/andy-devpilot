namespace DevPilot.Infrastructure.GitHub;

using DevPilot.Application.Services;
using Microsoft.Extensions.Logging;
using Octokit;

/// <summary>
/// Implementation of IGitHubService using Octokit
/// Handles communication with GitHub API
/// </summary>
public class GitHubService : IGitHubService
{
    private readonly ILogger<GitHubService> _logger;

    public GitHubService(ILogger<GitHubService> logger)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<IEnumerable<GitHubRepositoryDto>> GetRepositoriesAsync(
        string accessToken,
        CancellationToken cancellationToken = default)
    {
        var client = CreateGitHubClient(accessToken);

        try
        {
            // Fetch all repositories for the authenticated user
            var repositories = await client.Repository.GetAllForCurrent();

            return repositories.Select(r => MapToDto(r));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching repositories from GitHub");
            throw;
        }
    }

    public async System.Threading.Tasks.Task<IEnumerable<GitHubRepositoryDto>> GetOrganizationRepositoriesAsync(
        string accessToken,
        string organizationName,
        CancellationToken cancellationToken = default)
    {
        var client = CreateGitHubClient(accessToken);

        try
        {
            var repositories = await client.Repository.GetAllForOrg(organizationName);

            return repositories.Select(r => MapToDto(r));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching organization repositories from GitHub for {OrganizationName}", organizationName);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<GitHubPullRequestDto> CreatePullRequestAsync(
        string accessToken,
        string owner,
        string repo,
        string head,
        string baseBranch,
        string title,
        string? body = null,
        CancellationToken cancellationToken = default)
    {
        var client = CreateGitHubClient(accessToken);

        try
        {
            var prRequest = new NewPullRequest(title, head, baseBranch)
            {
                Body = body ?? string.Empty
            };

            var pr = await client.PullRequest.Create(owner, repo, prRequest);

            return new GitHubPullRequestDto
            {
                Url = pr.HtmlUrl ?? pr.Url,
                Number = pr.Number,
                Title = pr.Title ?? title
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error creating pull request for {Owner}/{Repo}", owner, repo);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<PullRequestStatusDto> GetPullRequestStatusAsync(
        string accessToken,
        string prUrl,
        CancellationToken cancellationToken = default)
    {
        var client = CreateGitHubClient(accessToken);

        try
        {
            // Parse PR URL: https://github.com/owner/repo/pull/123
            var (owner, repo, prNumber) = ParsePrUrl(prUrl);

            _logger.LogInformation("Checking PR status for {Owner}/{Repo}#{PrNumber}", owner, repo, prNumber);

            var pr = await client.PullRequest.Get(owner, repo, prNumber);

            return new PullRequestStatusDto
            {
                State = pr.State.StringValue, // "open" or "closed"
                IsMerged = pr.Merged,
                MergedAt = pr.MergedAt?.ToString("o")
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting PR status for {PrUrl}", prUrl);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<string?> GetPullRequestHeadBranchAsync(
        string accessToken,
        string prUrl,
        CancellationToken cancellationToken = default)
    {
        var client = CreateGitHubClient(accessToken);

        try
        {
            var (owner, repo, prNumber) = ParsePrUrl(prUrl);
            var pr = await client.PullRequest.Get(owner, repo, prNumber);
            return pr.Head?.Ref;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Error getting PR head branch for {PrUrl}", prUrl);
            return null;
        }
    }

    /// <summary>
    /// Parses a GitHub PR URL to extract owner, repo, and PR number
    /// Example: https://github.com/owner/repo/pull/123
    /// </summary>
    private (string owner, string repo, int prNumber) ParsePrUrl(string prUrl)
    {
        // Remove trailing slash if present
        prUrl = prUrl.TrimEnd('/');

        // Try to parse the URL
        if (!Uri.TryCreate(prUrl, UriKind.Absolute, out var uri))
        {
            throw new ArgumentException($"Invalid PR URL format: {prUrl}");
        }

        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        
        // Expected format: /owner/repo/pull/123
        if (segments.Length < 4 || segments[2] != "pull")
        {
            throw new ArgumentException($"Invalid PR URL format. Expected: https://github.com/owner/repo/pull/123, got: {prUrl}");
        }

        var owner = segments[0];
        var repo = segments[1];
        
        if (!int.TryParse(segments[3], out var prNumber))
        {
            throw new ArgumentException($"Invalid PR number in URL: {prUrl}");
        }

        return (owner, repo, prNumber);
    }

    private GitHubClient CreateGitHubClient(string accessToken)
    {
        var client = new GitHubClient(new ProductHeaderValue("DevPilot"))
        {
            Credentials = new Credentials(accessToken)
        };

        return client;
    }

    public async System.Threading.Tasks.Task<GitHubIssuesHierarchyDto> GetIssuesAsync(
        string accessToken,
        string owner,
        string repo,
        CancellationToken cancellationToken = default)
    {
        var client = CreateGitHubClient(accessToken);

        try
        {
            var result = new GitHubIssuesHierarchyDto();

            // Fetch all milestones
            var milestonesRequest = new MilestoneRequest
            {
                State = ItemStateFilter.All,
                SortProperty = MilestoneSort.DueDate,
                SortDirection = SortDirection.Ascending
            };
            
            var milestones = await client.Issue.Milestone.GetAllForRepository(owner, repo, milestonesRequest);
            
            foreach (var milestone in milestones)
            {
                result.Milestones.Add(new GitHubMilestoneDto
                {
                    Number = milestone.Number,
                    Title = milestone.Title ?? $"Milestone {milestone.Number}",
                    Description = milestone.Description,
                    State = milestone.State.StringValue,
                    OpenIssues = milestone.OpenIssues,
                    ClosedIssues = milestone.ClosedIssues,
                    DueOn = milestone.DueOn?.DateTime,
                    CreatedAt = milestone.CreatedAt.DateTime,
                    Url = milestone.HtmlUrl
                });
            }

            _logger.LogInformation("Found {Count} milestones in {Owner}/{Repo}", result.Milestones.Count, owner, repo);

            // Fetch all issues (excluding pull requests)
            var issuesRequest = new RepositoryIssueRequest
            {
                State = ItemStateFilter.All,
                SortProperty = IssueSort.Created,
                SortDirection = SortDirection.Descending
            };

            var issues = await client.Issue.GetAllForRepository(owner, repo, issuesRequest);

            foreach (var issue in issues)
            {
                // Skip pull requests (GitHub returns PRs in the issues endpoint)
                if (issue.PullRequest != null)
                {
                    continue;
                }

                var issueDto = new GitHubIssueDto
                {
                    Number = issue.Number,
                    Title = issue.Title ?? $"Issue #{issue.Number}",
                    Body = issue.Body,
                    State = issue.State.StringValue,
                    Assignee = issue.Assignee?.Login,
                    Labels = issue.Labels?.Select(l => l.Name).ToList() ?? new List<string>(),
                    MilestoneNumber = issue.Milestone?.Number,
                    MilestoneTitle = issue.Milestone?.Title,
                    Url = issue.HtmlUrl ?? $"https://github.com/{owner}/{repo}/issues/{issue.Number}",
                    CreatedAt = issue.CreatedAt.DateTime,
                    UpdatedAt = issue.UpdatedAt?.DateTime,
                    ClosedAt = issue.ClosedAt?.DateTime,
                    IsPullRequest = false
                };

                result.Issues.Add(issueDto);

                // Also categorize into unassigned if no milestone
                if (issue.Milestone == null)
                {
                    result.UnassignedIssues.Add(issueDto);
                }
            }

            _logger.LogInformation(
                "Found {TotalCount} issues in {Owner}/{Repo} ({UnassignedCount} without milestone)",
                result.Issues.Count, owner, repo, result.UnassignedIssues.Count);

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching issues from GitHub for {Owner}/{Repo}", owner, repo);
            throw;
        }
    }

    private GitHubRepositoryDto MapToDto(Octokit.Repository repository)
    {
        // Extract organization name from full name (format: "org/repo")
        var organizationName = repository.FullName.Split('/')[0];

        return new GitHubRepositoryDto
        {
            Name = repository.Name,
            FullName = repository.FullName,
            CloneUrl = repository.CloneUrl ?? repository.HtmlUrl + ".git",
            Description = repository.Description,
            IsPrivate = repository.Private,
            OrganizationName = organizationName,
            DefaultBranch = repository.DefaultBranch
        };
    }

    public async System.Threading.Tasks.Task<RepositoryTreeDto> GetRepositoryTreeAsync(
        string accessToken,
        string owner,
        string repo,
        string? path = null,
        string? branch = null,
        CancellationToken cancellationToken = default)
    {
        var client = CreateGitHubClient(accessToken);

        try
        {
            // Get default branch if not specified
            if (string.IsNullOrEmpty(branch))
            {
                var repository = await client.Repository.Get(owner, repo);
                branch = repository.DefaultBranch ?? "main";
            }

            var result = new RepositoryTreeDto
            {
                Path = path ?? "",
                Branch = branch
            };

            // Get directory contents
            IReadOnlyList<RepositoryContent> contents;
            if (string.IsNullOrEmpty(path))
            {
                contents = await client.Repository.Content.GetAllContentsByRef(owner, repo, branch);
            }
            else
            {
                contents = await client.Repository.Content.GetAllContentsByRef(owner, repo, path, branch);
            }

            // Sort: directories first, then files, both alphabetically
            var sortedContents = contents
                .OrderBy(c => c.Type.Value == ContentType.Dir ? 0 : 1)
                .ThenBy(c => c.Name, StringComparer.OrdinalIgnoreCase);

            foreach (var content in sortedContents)
            {
                result.Items.Add(new RepositoryTreeItemDto
                {
                    Name = content.Name,
                    Path = content.Path,
                    Type = content.Type.Value == ContentType.Dir ? "dir" : 
                           content.Type.Value == ContentType.File ? "file" :
                           content.Type.Value == ContentType.Symlink ? "symlink" : "submodule",
                    Size = content.Size,
                    Sha = content.Sha,
                    Url = content.HtmlUrl
                });

                // Check for README
                if (content.Type.Value == ContentType.File && 
                    content.Name.StartsWith("README", StringComparison.OrdinalIgnoreCase))
                {
                    try
                    {
                        var readmeContent = await client.Repository.Content.GetAllContentsByRef(owner, repo, content.Path, branch);
                        if (readmeContent.Count > 0 && readmeContent[0].Content != null)
                        {
                            result.Readme = System.Text.Encoding.UTF8.GetString(
                                Convert.FromBase64String(readmeContent[0].Content));
                        }
                    }
                    catch
                    {
                        // Ignore README fetch errors
                    }
                }
            }

            _logger.LogInformation("Fetched {Count} items from {Owner}/{Repo}/{Path} on branch {Branch}",
                result.Items.Count, owner, repo, path ?? "root", branch);

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching repository tree for {Owner}/{Repo}/{Path}", owner, repo, path);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<RepositoryFileContentDto> GetFileContentAsync(
        string accessToken,
        string owner,
        string repo,
        string path,
        string? branch = null,
        CancellationToken cancellationToken = default)
    {
        var client = CreateGitHubClient(accessToken);

        try
        {
            // Get default branch if not specified
            if (string.IsNullOrEmpty(branch))
            {
                var repository = await client.Repository.Get(owner, repo);
                branch = repository.DefaultBranch ?? "main";
            }

            var contents = await client.Repository.Content.GetAllContentsByRef(owner, repo, path, branch);
            
            if (contents.Count == 0)
            {
                throw new FileNotFoundException($"File not found: {path}");
            }

            var file = contents[0];
            var isBinary = IsBinaryFile(file.Name, file.Content);
            var language = DetectLanguage(file.Name);

            string content;
            if (isBinary)
            {
                content = "[Binary file - cannot display]";
            }
            else if (file.Content != null)
            {
                try
                {
                    content = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(file.Content));
                }
                catch
                {
                    content = file.Content;
                }
            }
            else
            {
                content = "";
            }

            return new RepositoryFileContentDto
            {
                Name = file.Name,
                Path = file.Path,
                Content = content,
                Encoding = "utf-8",
                Size = file.Size,
                Sha = file.Sha,
                Language = language,
                IsBinary = isBinary,
                IsTruncated = file.Size > 1_000_000 // 1MB limit
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching file content for {Owner}/{Repo}/{Path}", owner, repo, path);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<IEnumerable<RepositoryBranchDto>> GetBranchesAsync(
        string accessToken,
        string owner,
        string repo,
        CancellationToken cancellationToken = default)
    {
        var client = CreateGitHubClient(accessToken);

        try
        {
            var repository = await client.Repository.Get(owner, repo);
            var defaultBranch = repository.DefaultBranch;

            var branches = await client.Repository.Branch.GetAll(owner, repo);

            return branches.Select(b => new RepositoryBranchDto
            {
                Name = b.Name,
                Sha = b.Commit.Sha,
                IsDefault = b.Name == defaultBranch,
                IsProtected = b.Protected
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching branches for {Owner}/{Repo}", owner, repo);
            throw;
        }
    }

    private bool IsBinaryFile(string fileName, string? content)
    {
        // Check by extension
        var binaryExtensions = new[] { 
            ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp",
            ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
            ".zip", ".tar", ".gz", ".rar", ".7z",
            ".exe", ".dll", ".so", ".dylib",
            ".woff", ".woff2", ".ttf", ".eot",
            ".mp3", ".mp4", ".avi", ".mov", ".wav",
            ".sqlite", ".db"
        };

        var ext = System.IO.Path.GetExtension(fileName).ToLowerInvariant();
        if (binaryExtensions.Contains(ext))
        {
            return true;
        }

        // Check content for null bytes (binary indicator)
        if (content != null)
        {
            try
            {
                var decoded = Convert.FromBase64String(content);
                return decoded.Take(8000).Any(b => b == 0);
            }
            catch
            {
                return false;
            }
        }

        return false;
    }

    private string? DetectLanguage(string fileName)
    {
        var ext = System.IO.Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".cs" => "csharp",
            ".ts" => "typescript",
            ".tsx" => "typescript",
            ".js" => "javascript",
            ".jsx" => "javascript",
            ".py" => "python",
            ".java" => "java",
            ".go" => "go",
            ".rs" => "rust",
            ".rb" => "ruby",
            ".php" => "php",
            ".swift" => "swift",
            ".kt" => "kotlin",
            ".scala" => "scala",
            ".c" => "c",
            ".cpp" or ".cc" or ".cxx" => "cpp",
            ".h" or ".hpp" => "cpp",
            ".html" or ".htm" => "html",
            ".css" => "css",
            ".scss" or ".sass" => "scss",
            ".less" => "less",
            ".json" => "json",
            ".xml" => "xml",
            ".yaml" or ".yml" => "yaml",
            ".md" or ".markdown" => "markdown",
            ".sql" => "sql",
            ".sh" or ".bash" => "bash",
            ".ps1" => "powershell",
            ".dockerfile" => "dockerfile",
            ".graphql" or ".gql" => "graphql",
            ".proto" => "protobuf",
            ".vue" => "vue",
            ".svelte" => "svelte",
            _ when fileName.ToLowerInvariant() == "dockerfile" => "dockerfile",
            _ when fileName.ToLowerInvariant() == "makefile" => "makefile",
            _ when fileName.ToLowerInvariant().EndsWith(".csproj") => "xml",
            _ when fileName.ToLowerInvariant().EndsWith(".sln") => "text",
            _ => null
        };
    }

    public async System.Threading.Tasks.Task<IEnumerable<PullRequestDto>> GetPullRequestsAsync(
        string accessToken,
        string owner,
        string repo,
        string? state = "all",
        CancellationToken cancellationToken = default)
    {
        var client = CreateGitHubClient(accessToken);

        try
        {
            var request = new PullRequestRequest
            {
                State = state?.ToLowerInvariant() switch
                {
                    "open" => ItemStateFilter.Open,
                    "closed" => ItemStateFilter.Closed,
                    _ => ItemStateFilter.All
                },
                SortProperty = PullRequestSort.Updated,
                SortDirection = SortDirection.Descending
            };

            var pullRequests = await client.PullRequest.GetAllForRepository(owner, repo, request);
            var result = new List<PullRequestDto>();

            // Fetch details for each PR to get additions/deletions (limited to first 20 to avoid rate limiting)
            var prNumbers = pullRequests.Take(20).Select(pr => pr.Number).ToList();
            var detailTasks = prNumbers.Select(num => client.PullRequest.Get(owner, repo, num));
            var prDetails = await System.Threading.Tasks.Task.WhenAll(detailTasks);
            var detailsMap = prDetails.ToDictionary(pr => pr.Number);

            foreach (var pr in pullRequests)
            {
                // Try to get detailed info, fall back to list data
                var hasDetails = detailsMap.TryGetValue(pr.Number, out var details);
                
                var prDto = new PullRequestDto
                {
                    Number = pr.Number,
                    Title = pr.Title ?? $"PR #{pr.Number}",
                    Description = pr.Body,
                    State = pr.Merged ? "merged" : pr.State.StringValue,
                    SourceBranch = pr.Head?.Ref ?? "unknown",
                    TargetBranch = pr.Base?.Ref ?? "unknown",
                    Author = pr.User?.Login ?? "unknown",
                    AuthorAvatarUrl = pr.User?.AvatarUrl,
                    Url = pr.HtmlUrl ?? $"https://github.com/{owner}/{repo}/pull/{pr.Number}",
                    CreatedAt = pr.CreatedAt.DateTime,
                    UpdatedAt = pr.UpdatedAt.DateTime,
                    MergedAt = pr.MergedAt?.DateTime,
                    ClosedAt = pr.ClosedAt?.DateTime,
                    IsMerged = pr.Merged,
                    IsDraft = pr.Draft,
                    Comments = hasDetails ? details!.Comments : pr.Comments,
                    Commits = hasDetails ? details!.Commits : pr.Commits,
                    Additions = hasDetails ? details!.Additions : pr.Additions,
                    Deletions = hasDetails ? details!.Deletions : pr.Deletions,
                    ChangedFiles = hasDetails ? details!.ChangedFiles : pr.ChangedFiles,
                    Labels = pr.Labels?.Select(l => l.Name).ToList() ?? new List<string>(),
                    Reviewers = pr.RequestedReviewers?.Select(r => r.Login).ToList() ?? new List<string>()
                };

                result.Add(prDto);
            }

            _logger.LogInformation("Found {Count} pull requests in {Owner}/{Repo}", result.Count, owner, repo);
            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching pull requests from GitHub for {Owner}/{Repo}", owner, repo);
            throw;
        }
    }
}
