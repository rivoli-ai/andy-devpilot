namespace DevPilot.Application.UseCases;

using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

public record ApplyGitHubBacklogSyncCommand(
    Guid RepositoryId,
    Guid UserId,
    IReadOnlyList<Guid> PullEpicIds,
    IReadOnlyList<Guid> PullFeatureIds,
    IReadOnlyList<Guid> PullStoryIds,
    IReadOnlyList<Guid> PushEpicIds,
    IReadOnlyList<Guid> PushFeatureIds,
    IReadOnlyList<Guid> PushStoryIds,
    IReadOnlyList<Guid> CreateEpicIds,
    IReadOnlyList<Guid> CreateFeatureIds,
    IReadOnlyList<Guid> CreateStoryIds) : IRequest<ApplyGitHubBacklogSyncResult>;

public class ApplyGitHubBacklogSyncResult
{
    public int CreatedCount { get; set; }
    public int PulledCount { get; set; }
    public int PushedCount { get; set; }
    public int FailedCount { get; set; }
    public List<string> Errors { get; set; } = new();
    public bool Success => FailedCount == 0;
}

/// <summary>
/// Runs create-on-GitHub, pull-from-GitHub, and push-to-GitHub for the given buckets.
/// </summary>
public class ApplyGitHubBacklogSyncCommandHandler : IRequestHandler<ApplyGitHubBacklogSyncCommand, ApplyGitHubBacklogSyncResult>
{
    private readonly IEpicRepository _epicRepository;
    private readonly IFeatureRepository _featureRepository;
    private readonly IUserStoryRepository _userStoryRepository;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IUserRepository _userRepository;
    private readonly ILinkedProviderRepository _linkedProviderRepository;
    private readonly IGitHubService _gitHubService;
    private readonly ILogger<ApplyGitHubBacklogSyncCommandHandler> _logger;

    public ApplyGitHubBacklogSyncCommandHandler(
        IEpicRepository epicRepository,
        IFeatureRepository featureRepository,
        IUserStoryRepository userStoryRepository,
        IRepositoryRepository repositoryRepository,
        IUserRepository userRepository,
        ILinkedProviderRepository linkedProviderRepository,
        IGitHubService gitHubService,
        ILogger<ApplyGitHubBacklogSyncCommandHandler> logger)
    {
        _epicRepository = epicRepository;
        _featureRepository = featureRepository;
        _userStoryRepository = userStoryRepository;
        _repositoryRepository = repositoryRepository;
        _userRepository = userRepository;
        _linkedProviderRepository = linkedProviderRepository;
        _gitHubService = gitHubService;
        _logger = logger;
    }

    public async Task<ApplyGitHubBacklogSyncResult> Handle(ApplyGitHubBacklogSyncCommand command, CancellationToken cancellationToken)
    {
        var outResult = new ApplyGitHubBacklogSyncResult();

        var repository = await _repositoryRepository.GetByIdIfAccessibleAsync(command.RepositoryId, command.UserId, cancellationToken);
        if (repository == null)
        {
            outResult.Errors.Add("Repository not found or access denied.");
            outResult.FailedCount++;
            return outResult;
        }

        if (!string.Equals(repository.Provider, "GitHub", StringComparison.OrdinalIgnoreCase))
        {
            outResult.Errors.Add("Unified GitHub sync is only supported for GitHub repositories.");
            outResult.FailedCount++;
            return outResult;
        }

        var parts = repository.FullName.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2)
        {
            outResult.Errors.Add($"Repository full name '{repository.FullName}' is invalid. Expected format: owner/repo");
            outResult.FailedCount++;
            return outResult;
        }

        var owner = parts[0];
        var repoName = parts[1];

        var accessToken = await GetGitHubAccessTokenAsync(command.UserId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            outResult.Errors.Add("GitHub access token is not configured. Link GitHub in Settings.");
            outResult.FailedCount++;
            return outResult;
        }

        var epics = (await _epicRepository.GetByRepositoryIdAsync(command.RepositoryId, cancellationToken)).ToList();

        var createN = command.CreateEpicIds.Count + command.CreateFeatureIds.Count + command.CreateStoryIds.Count;
        var pullN = command.PullEpicIds.Count + command.PullFeatureIds.Count + command.PullStoryIds.Count;
        var pushN = command.PushEpicIds.Count + command.PushFeatureIds.Count + command.PushStoryIds.Count;
        if (createN + pullN + pushN == 0)
        {
            outResult.Errors.Add("Nothing to sync: assign at least one item to create, pull, or push.");
            outResult.FailedCount++;
            return outResult;
        }

        foreach (var id in command.CreateEpicIds)
        {
            var epic = FindEpic(epics, id);
            if (epic == null)
            {
                RecordFailure(outResult, $"Epic {id} not found.");
                continue;
            }

            if (epic.GitHubIssueNumber.HasValue)
            {
                RecordFailure(outResult, $"Epic '{epic.Title}' already has a GitHub issue.");
                continue;
            }

            try
            {
                var number = await _gitHubService.CreateIssueAsync(
                    accessToken,
                    owner,
                    repoName,
                    epic.Title,
                    epic.Description,
                    cancellationToken);
                epic.SetGitHubIssueNumber(number);
                epic.SetSource("GitHub");
                await _epicRepository.UpdateAsync(epic, cancellationToken);
                outResult.CreatedCount++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to create GitHub issue for epic {EpicId}", id);
                RecordFailure(outResult, $"Epic '{epic.Title}': {ex.Message}");
            }
        }

        foreach (var id in command.CreateFeatureIds)
        {
            var feature = FindFeature(epics, id);
            if (feature == null)
            {
                RecordFailure(outResult, $"Feature {id} not found.");
                continue;
            }

            if (feature.GitHubIssueNumber.HasValue)
            {
                RecordFailure(outResult, $"Feature '{feature.Title}' already has a GitHub issue.");
                continue;
            }

            try
            {
                var number = await _gitHubService.CreateIssueAsync(
                    accessToken,
                    owner,
                    repoName,
                    feature.Title,
                    feature.Description,
                    cancellationToken);
                feature.SetGitHubIssueNumber(number);
                feature.SetSource("GitHub");
                await _featureRepository.UpdateAsync(feature, cancellationToken);
                outResult.CreatedCount++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to create GitHub issue for feature {FeatureId}", id);
                RecordFailure(outResult, $"Feature '{feature.Title}': {ex.Message}");
            }
        }

        foreach (var id in command.CreateStoryIds)
        {
            var story = FindStory(epics, id);
            if (story == null)
            {
                RecordFailure(outResult, $"Story {id} not found.");
                continue;
            }

            if (story.GitHubIssueNumber.HasValue)
            {
                RecordFailure(outResult, $"Story '{story.Title}' already has a GitHub issue.");
                continue;
            }

            try
            {
                var number = await _gitHubService.CreateIssueAsync(
                    accessToken,
                    owner,
                    repoName,
                    story.Title,
                    story.Description,
                    cancellationToken);
                story.SetGitHubIssueNumber(number);
                story.SetSource("GitHub");
                await _userStoryRepository.UpdateAsync(story, cancellationToken);
                outResult.CreatedCount++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to create GitHub issue for story {StoryId}", id);
                RecordFailure(outResult, $"Story '{story.Title}': {ex.Message}");
            }
        }

        foreach (var id in command.PullEpicIds)
        {
            var epic = FindEpic(epics, id);
            if (epic?.GitHubIssueNumber is not { } num)
            {
                RecordFailure(outResult, $"Epic {id} is not linked to a GitHub issue.");
                continue;
            }

            try
            {
                var issue = await _gitHubService.GetIssueAsync(accessToken, owner, repoName, num, cancellationToken);
                ApplyIssueToEpic(epic, issue);
                await _epicRepository.UpdateAsync(epic, cancellationToken);
                outResult.PulledCount++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to pull GitHub issue for epic {EpicId}", id);
                RecordFailure(outResult, $"Epic '{epic.Title}' (#{num}): {ex.Message}");
            }
        }

        foreach (var id in command.PullFeatureIds)
        {
            var feature = FindFeature(epics, id);
            if (feature?.GitHubIssueNumber is not { } num)
            {
                RecordFailure(outResult, $"Feature {id} is not linked to a GitHub issue.");
                continue;
            }

            try
            {
                var issue = await _gitHubService.GetIssueAsync(accessToken, owner, repoName, num, cancellationToken);
                ApplyIssueToFeature(feature, issue);
                await _featureRepository.UpdateAsync(feature, cancellationToken);
                outResult.PulledCount++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to pull GitHub issue for feature {FeatureId}", id);
                RecordFailure(outResult, $"Feature '{feature.Title}' (#{num}): {ex.Message}");
            }
        }

        foreach (var id in command.PullStoryIds)
        {
            var story = FindStory(epics, id);
            if (story?.GitHubIssueNumber is not { } num)
            {
                RecordFailure(outResult, $"Story {id} is not linked to a GitHub issue.");
                continue;
            }

            try
            {
                var issue = await _gitHubService.GetIssueAsync(accessToken, owner, repoName, num, cancellationToken);
                ApplyIssueToStory(story, issue);
                await _userStoryRepository.UpdateAsync(story, cancellationToken);
                outResult.PulledCount++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to pull GitHub issue for story {StoryId}", id);
                RecordFailure(outResult, $"Story '{story.Title}' (#{num}): {ex.Message}");
            }
        }

        foreach (var id in command.PushEpicIds)
        {
            var epic = FindEpic(epics, id);
            if (epic?.GitHubIssueNumber is not { } num)
            {
                RecordFailure(outResult, $"Epic {id} is not linked to a GitHub issue.");
                continue;
            }

            try
            {
                var ghState = MapAppStatusToGitHubState(epic.Status);
                await _gitHubService.UpdateIssueAsync(
                    accessToken,
                    owner,
                    repoName,
                    num,
                    epic.Title,
                    epic.Description ?? string.Empty,
                    ghState,
                    cancellationToken);
                outResult.PushedCount++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to push epic {EpicId} to GitHub", id);
                RecordFailure(outResult, $"Epic '{epic.Title}' (#{num}): {ex.Message}");
            }
        }

        foreach (var id in command.PushFeatureIds)
        {
            var feature = FindFeature(epics, id);
            if (feature?.GitHubIssueNumber is not { } num)
            {
                RecordFailure(outResult, $"Feature {id} is not linked to a GitHub issue.");
                continue;
            }

            try
            {
                var ghState = MapAppStatusToGitHubState(feature.Status);
                await _gitHubService.UpdateIssueAsync(
                    accessToken,
                    owner,
                    repoName,
                    num,
                    feature.Title,
                    feature.Description ?? string.Empty,
                    ghState,
                    cancellationToken);
                outResult.PushedCount++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to push feature {FeatureId} to GitHub", id);
                RecordFailure(outResult, $"Feature '{feature.Title}' (#{num}): {ex.Message}");
            }
        }

        foreach (var id in command.PushStoryIds)
        {
            var story = FindStory(epics, id);
            if (story?.GitHubIssueNumber is not { } num)
            {
                RecordFailure(outResult, $"Story {id} is not linked to a GitHub issue.");
                continue;
            }

            try
            {
                var ghState = MapAppStatusToGitHubState(story.Status);
                await _gitHubService.UpdateIssueAsync(
                    accessToken,
                    owner,
                    repoName,
                    num,
                    story.Title,
                    story.Description ?? string.Empty,
                    ghState,
                    cancellationToken);
                outResult.PushedCount++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to push story {StoryId} to GitHub", id);
                RecordFailure(outResult, $"Story '{story.Title}' (#{num}): {ex.Message}");
            }
        }

        return outResult;
    }

    private static void RecordFailure(ApplyGitHubBacklogSyncResult result, string message)
    {
        result.FailedCount++;
        result.Errors.Add(message);
    }

    private static Epic? FindEpic(List<Epic> epics, Guid id) => epics.FirstOrDefault(e => e.Id == id);

    private static Feature? FindFeature(List<Epic> epics, Guid id)
    {
        foreach (var epic in epics)
        {
            var f = epic.Features.FirstOrDefault(x => x.Id == id);
            if (f != null) return f;
        }

        return null;
    }

    private static UserStory? FindStory(List<Epic> epics, Guid id)
    {
        foreach (var epic in epics)
        {
            foreach (var feature in epic.Features)
            {
                var s = feature.UserStories.FirstOrDefault(x => x.Id == id);
                if (s != null) return s;
            }
        }

        return null;
    }

    private static void ApplyIssueToEpic(Epic epic, GitHubIssueDto issue)
    {
        epic.UpdateTitle(issue.Title ?? epic.Title);
        epic.UpdateDescription(issue.Body);
        epic.ChangeStatus(MapGitHubStateToAppStatus(issue.State));
        epic.SetSource("GitHub");
    }

    private static void ApplyIssueToFeature(Feature feature, GitHubIssueDto issue)
    {
        feature.UpdateTitle(issue.Title ?? feature.Title);
        feature.UpdateDescription(issue.Body);
        feature.ChangeStatus(MapGitHubStateToAppStatus(issue.State));
        feature.SetSource("GitHub");
    }

    private static void ApplyIssueToStory(UserStory story, GitHubIssueDto issue)
    {
        story.UpdateTitle(issue.Title ?? story.Title);
        story.UpdateDescription(issue.Body);
        story.ChangeStatus(MapGitHubStateToAppStatus(issue.State), null);
        story.SetSource("GitHub");
    }

    private static string MapGitHubStateToAppStatus(string? ghState)
    {
        if (string.Equals(ghState, "closed", StringComparison.OrdinalIgnoreCase))
            return "Done";
        return "Backlog";
    }

    private static string MapAppStatusToGitHubState(string status)
    {
        var normalized = status.Trim().Replace(" ", "").ToLowerInvariant();
        return normalized switch
        {
            "done" or "implemented" or "resolved" or "completed" => "closed",
            _ => "open"
        };
    }

    private async Task<string?> GetGitHubAccessTokenAsync(Guid userId, CancellationToken cancellationToken)
    {
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
        if (!string.IsNullOrEmpty(linkedProvider?.AccessToken))
            return linkedProvider.AccessToken;

        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        return user?.GitHubAccessToken;
    }
}
