namespace DevPilot.Application.Services;

/// <summary>
    /// Manages sandbox container lifecycle via the VPS manager API.
    /// All calls are authenticated with the static manager API key; callers only
    /// need to supply the authenticated user ID for ownership tracking.
    /// </summary>
    public interface ISandboxService
    {
        /// <summary>Creates a new sandbox container and returns its connection details.</summary>
        Task<SandboxCreateResult> CreateSandboxAsync(
            Guid userId,
            SandboxCreateRequest request,
            CancellationToken cancellationToken = default);

        /// <summary>Returns all sandboxes owned by the given user.</summary>
        Task<IReadOnlyList<SandboxListItem>> ListSandboxesAsync(
            Guid userId,
            CancellationToken cancellationToken = default);

        /// <summary>Returns the current status of a sandbox owned by the given user.</summary>
        Task<SandboxStatusResult?> GetSandboxAsync(
            Guid userId,
            string sandboxId,
            CancellationToken cancellationToken = default);

        /// <summary>Stops and removes a sandbox owned by the given user.</summary>
        Task<bool> DeleteSandboxAsync(
            Guid userId,
            string sandboxId,
            CancellationToken cancellationToken = default);
    }

public record SandboxCreateRequest
{
    public string? Resolution { get; init; }
    public string? RepoUrl { get; init; }
    public string? RepoName { get; init; }
    public string? RepoBranch { get; init; }
    public string? RepoArchiveUrl { get; init; }
    public string? GithubToken { get; init; }
    public string? AzureDevOpsPat { get; init; }
    public SandboxAiConfig? AiConfig { get; init; }
    public object? ZedSettings { get; init; }
    public List<SandboxArtifactFeed>? ArtifactFeeds { get; init; }
    public string? AgentRules { get; init; }
    public string? AzureIdentityClientId { get; init; }
    public string? AzureIdentityClientSecret { get; init; }
    public string? AzureIdentityTenantId { get; init; }
}

public record SandboxArtifactFeed
{
    public string Name { get; init; } = "";
    public string Organization { get; init; } = "";
    public string FeedName { get; init; } = "";
    public string? ProjectName { get; init; }
    public string FeedType { get; init; } = "nuget";
}

public record SandboxAiConfig
{
    public string Provider { get; init; } = "openai";
    public string? ApiKey { get; init; }
    public string Model { get; init; } = "gpt-4o";
    public string? BaseUrl { get; init; }
}

public record SandboxCreateResult
{
    public string Id { get; init; } = string.Empty;
    public string Status { get; init; } = string.Empty;
    public string VncPassword { get; init; } = string.Empty;
}

public record SandboxListItem
{
    public string Id { get; init; } = string.Empty;
    public string Status { get; init; } = string.Empty;
}

public record SandboxStatusResult
{
    public string Id { get; init; } = string.Empty;
    public string Status { get; init; } = string.Empty;
}
