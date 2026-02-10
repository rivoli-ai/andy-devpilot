namespace DevPilot.Application.UseCases;

using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

public record SyncBacklogToGitHubCommand(
    Guid RepositoryId,
    Guid UserId,
    IReadOnlyList<Guid> EpicIds,
    IReadOnlyList<Guid> FeatureIds,
    IReadOnlyList<Guid> StoryIds) : IRequest<SyncBacklogToGitHubResult>;

public class SyncBacklogToGitHubResult
{
    public bool Success { get; set; }
    public int SyncedCount { get; set; }
    public int FailedCount { get; set; }
    public List<string> Errors { get; set; } = new();
}

/// <summary>
/// Syncs backlog items (Features, User Stories) that were imported from GitHub
/// back to GitHub with current title, description, status.
/// </summary>
public class SyncBacklogToGitHubCommandHandler : IRequestHandler<SyncBacklogToGitHubCommand, SyncBacklogToGitHubResult>
{
    private readonly IEpicRepository _epicRepository;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IUserRepository _userRepository;
    private readonly ILinkedProviderRepository _linkedProviderRepository;
    private readonly IGitHubService _gitHubService;
    private readonly ILogger<SyncBacklogToGitHubCommandHandler> _logger;

    public SyncBacklogToGitHubCommandHandler(
        IEpicRepository epicRepository,
        IRepositoryRepository repositoryRepository,
        IUserRepository userRepository,
        ILinkedProviderRepository linkedProviderRepository,
        IGitHubService gitHubService,
        ILogger<SyncBacklogToGitHubCommandHandler> logger)
    {
        _epicRepository = epicRepository ?? throw new ArgumentNullException(nameof(epicRepository));
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
        _linkedProviderRepository = linkedProviderRepository ?? throw new ArgumentNullException(nameof(linkedProviderRepository));
        _gitHubService = gitHubService ?? throw new ArgumentNullException(nameof(gitHubService));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<SyncBacklogToGitHubResult> Handle(
        SyncBacklogToGitHubCommand command,
        CancellationToken cancellationToken)
    {
        var result = new SyncBacklogToGitHubResult();

        var repository = await _repositoryRepository.GetByIdAsync(command.RepositoryId, cancellationToken);
        if (repository == null)
        {
            result.Success = false;
            result.Errors.Add($"Repository {command.RepositoryId} not found");
            return result;
        }

        if (repository.Provider != "GitHub")
        {
            result.Success = false;
            result.Errors.Add("Repository is not from GitHub. Sync is only supported for GitHub repositories.");
            return result;
        }

        // Parse owner/repo from FullName
        var parts = repository.FullName.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2)
        {
            result.Success = false;
            result.Errors.Add($"Repository full name '{repository.FullName}' is invalid. Expected format: owner/repo");
            return result;
        }

        var owner = parts[0];
        var repo = parts[1];

        var accessToken = await GetGitHubAccessTokenAsync(command.UserId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            result.Success = false;
            result.Errors.Add("GitHub access token is not configured. Please link your GitHub account in Settings.");
            return result;
        }

        var epics = await _epicRepository.GetByRepositoryIdAsync(command.RepositoryId, cancellationToken);
        var itemsToSync = new List<(int IssueNumber, string Title, string? Description, string Status)>();

        var epicIdsSet = command.EpicIds.Count > 0 ? new HashSet<Guid>(command.EpicIds) : null;
        var featureIdsSet = command.FeatureIds.Count > 0 ? new HashSet<Guid>(command.FeatureIds) : null;
        var storyIdsSet = command.StoryIds.Count > 0 ? new HashSet<Guid>(command.StoryIds) : null;
        var filterBySelection = epicIdsSet != null || featureIdsSet != null || storyIdsSet != null;

        foreach (var epic in epics)
        {
            foreach (var feature in epic.Features.Where(f => f.Source == "GitHub" && f.GitHubIssueNumber.HasValue))
            {
                if (filterBySelection && (featureIdsSet == null || !featureIdsSet.Contains(feature.Id)))
                    continue;
                itemsToSync.Add((feature.GitHubIssueNumber!.Value, feature.Title, feature.Description, feature.Status));
            }

            foreach (var feature in epic.Features)
            {
                foreach (var story in feature.UserStories.Where(s => s.Source == "GitHub" && s.GitHubIssueNumber.HasValue))
                {
                    if (filterBySelection && (storyIdsSet == null || !storyIdsSet.Contains(story.Id)))
                        continue;
                    itemsToSync.Add((story.GitHubIssueNumber!.Value, story.Title, story.Description, story.Status));
                }
            }
        }

        if (itemsToSync.Count == 0)
        {
            result.Success = true;
            result.SyncedCount = 0;
            result.Errors.Add("No items with GitHub link found to sync.");
            return result;
        }

        foreach (var (issueNumber, title, description, status) in itemsToSync)
        {
            try
            {
                var ghState = status.Trim().Replace(" ", "").ToLowerInvariant() switch
                {
                    "done" or "implemented" or "resolved" or "completed" => "closed",
                    _ => "open"
                };

                await _gitHubService.UpdateIssueAsync(
                    accessToken,
                    owner,
                    repo,
                    issueNumber,
                    title,
                    description ?? string.Empty,
                    ghState,
                    cancellationToken);

                result.SyncedCount++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to sync issue {IssueNumber} to GitHub", issueNumber);
                result.FailedCount++;
                result.Errors.Add($"Failed to sync issue #{issueNumber} ({title}): {ex.Message}");
            }
        }

        result.Success = result.FailedCount == 0;
        _logger.LogInformation("Sync to GitHub completed. Synced: {Synced}, Failed: {Failed}",
            result.SyncedCount, result.FailedCount);

        return result;
    }

    private async System.Threading.Tasks.Task<string?> GetGitHubAccessTokenAsync(Guid userId, CancellationToken cancellationToken)
    {
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
        if (!string.IsNullOrEmpty(linkedProvider?.AccessToken))
        {
            return linkedProvider.AccessToken;
        }

        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        return user?.GitHubAccessToken;
    }
}
