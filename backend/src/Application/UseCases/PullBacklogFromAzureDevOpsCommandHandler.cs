namespace DevPilot.Application.UseCases;

using System.Text.RegularExpressions;
using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

public record PullBacklogFromAzureDevOpsCommand(
    Guid RepositoryId,
    Guid UserId,
    string Organization,
    string ProjectName,
    IReadOnlyList<Guid> EpicIds,
    IReadOnlyList<Guid> FeatureIds,
    IReadOnlyList<Guid> StoryIds) : IRequest<PullBacklogFromAzureDevOpsResult>;

public class PullBacklogFromAzureDevOpsResult
{
    public bool Success { get; set; }
    public int UpdatedCount { get; set; }
    public int FailedCount { get; set; }
    public List<string> Errors { get; set; } = new();
}

/// <summary>
/// Updates local Epics/Features/Stories from Azure DevOps work items for the given selection.
/// </summary>
public class PullBacklogFromAzureDevOpsCommandHandler : IRequestHandler<PullBacklogFromAzureDevOpsCommand, PullBacklogFromAzureDevOpsResult>
{
    private readonly IEpicRepository _epicRepository;
    private readonly IFeatureRepository _featureRepository;
    private readonly IUserStoryRepository _userStoryRepository;
    private readonly IUserRepository _userRepository;
    private readonly IAzureDevOpsService _azureDevOpsService;
    private readonly ILogger<PullBacklogFromAzureDevOpsCommandHandler> _logger;

    public PullBacklogFromAzureDevOpsCommandHandler(
        IEpicRepository epicRepository,
        IFeatureRepository featureRepository,
        IUserStoryRepository userStoryRepository,
        IUserRepository userRepository,
        IAzureDevOpsService azureDevOpsService,
        ILogger<PullBacklogFromAzureDevOpsCommandHandler> logger)
    {
        _epicRepository = epicRepository;
        _featureRepository = featureRepository;
        _userStoryRepository = userStoryRepository;
        _userRepository = userRepository;
        _azureDevOpsService = azureDevOpsService;
        _logger = logger;
    }

    public async Task<PullBacklogFromAzureDevOpsResult> Handle(
        PullBacklogFromAzureDevOpsCommand command,
        CancellationToken cancellationToken)
    {
        var result = new PullBacklogFromAzureDevOpsResult();
        var organization = command.Organization.Trim();
        var project = command.ProjectName.Trim();

        var user = await _userRepository.GetByIdAsync(command.UserId, cancellationToken);
        if (user == null || string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
        {
            result.Errors.Add("Azure DevOps PAT is not configured. Add it in Settings.");
            return result;
        }

        var accessToken = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
        const bool useBasicAuth = true;

        var epicIdSet = new HashSet<Guid>(command.EpicIds);
        var featureIdSet = new HashSet<Guid>(command.FeatureIds);
        var storyIdSet = new HashSet<Guid>(command.StoryIds);
        var filter = epicIdSet.Count > 0 || featureIdSet.Count > 0 || storyIdSet.Count > 0;

        var epics = (await _epicRepository.GetByRepositoryIdAsync(command.RepositoryId, cancellationToken)).ToList();
        var adoIds = new List<int>();
        var epicByAdo = new Dictionary<int, Epic>();
        var featureByAdo = new Dictionary<int, Feature>();
        var storyByAdo = new Dictionary<int, UserStory>();

        foreach (var epic in epics)
        {
            if (epic.AzureDevOpsWorkItemId.HasValue && (!filter || epicIdSet.Contains(epic.Id)))
            {
                var id = epic.AzureDevOpsWorkItemId.Value;
                adoIds.Add(id);
                epicByAdo[id] = epic;
            }

            foreach (var feature in epic.Features)
            {
                if (feature.AzureDevOpsWorkItemId.HasValue && (!filter || featureIdSet.Contains(feature.Id)))
                {
                    var id = feature.AzureDevOpsWorkItemId.Value;
                    adoIds.Add(id);
                    featureByAdo[id] = feature;
                }

                foreach (var story in feature.UserStories)
                {
                    if (story.AzureDevOpsWorkItemId.HasValue && (!filter || storyIdSet.Contains(story.Id)))
                    {
                        var id = story.AzureDevOpsWorkItemId.Value;
                        adoIds.Add(id);
                        storyByAdo[id] = story;
                    }
                }
            }
        }

        if (adoIds.Count == 0)
        {
            result.Errors.Add("No selected items are linked to Azure DevOps work items.");
            return result;
        }

        IReadOnlyList<AzureDevOpsWorkItemDto> workItems;
        try
        {
            workItems = await _azureDevOpsService.GetWorkItemsByIdsAsync(
                accessToken, organization, project, adoIds, cancellationToken, useBasicAuth);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Fetch work items for pull failed");
            result.Errors.Add($"Could not read work items from Azure DevOps: {ex.Message}");
            return result;
        }

        var byId = workItems.ToDictionary(w => w.Id, w => w);

        foreach (var adoId in adoIds.Distinct())
        {
            if (!byId.TryGetValue(adoId, out var wi))
            {
                result.FailedCount++;
                result.Errors.Add($"Work item #{adoId} was not returned by Azure DevOps (check project '{project}').");
                continue;
            }

            try
            {
                var status = MapAdoStateToAppStatus(wi.State);
                var title = wi.Title ?? "";
                var description = StripHtmlToPlain(wi.Description);

                if (storyByAdo.TryGetValue(adoId, out var story))
                {
                    story.UpdateTitle(title);
                    story.UpdateDescription(string.IsNullOrEmpty(description) ? null : description);
                    story.UpdateAcceptanceCriteria(string.IsNullOrEmpty(wi.AcceptanceCriteria) ? null : StripHtmlToPlain(wi.AcceptanceCriteria));
                    if (wi.StoryPoints.HasValue)
                        story.SetStoryPoints((int)Math.Round(wi.StoryPoints.Value));
                    story.ChangeStatus(status);
                    await _userStoryRepository.UpdateAsync(story, cancellationToken);
                    result.UpdatedCount++;
                }
                else if (featureByAdo.TryGetValue(adoId, out var feature))
                {
                    feature.UpdateTitle(title);
                    feature.UpdateDescription(string.IsNullOrEmpty(description) ? null : description);
                    feature.ChangeStatus(status);
                    await _featureRepository.UpdateAsync(feature, cancellationToken);
                    result.UpdatedCount++;
                }
                else if (epicByAdo.TryGetValue(adoId, out var epic))
                {
                    epic.UpdateTitle(title);
                    epic.UpdateDescription(string.IsNullOrEmpty(description) ? null : description);
                    epic.ChangeStatus(status);
                    await _epicRepository.UpdateAsync(epic, cancellationToken);
                    result.UpdatedCount++;
                }
            }
            catch (Exception ex)
            {
                result.FailedCount++;
                _logger.LogWarning(ex, "Pull from ADO failed for work item {AdoId}", adoId);
                result.Errors.Add($"#{adoId} ({wi.Title}): {ex.Message}");
            }
        }

        result.Success = result.FailedCount == 0;
        return result;
    }

    private static string MapAdoStateToAppStatus(string? adoState)
    {
        if (string.IsNullOrWhiteSpace(adoState))
            return "Backlog";
        var s = adoState.Trim().ToLowerInvariant();
        if (s.Contains("done", StringComparison.Ordinal) || s.Contains("closed", StringComparison.Ordinal) ||
            s.Contains("removed", StringComparison.Ordinal) || s.Contains("complete", StringComparison.Ordinal) ||
            string.Equals(s, "resolved", StringComparison.Ordinal))
            return "Done";
        if (s.Contains("progress", StringComparison.Ordinal) || s.Contains("active", StringComparison.Ordinal) ||
            s.Contains("commit", StringComparison.Ordinal) || s.Contains("review", StringComparison.Ordinal))
            return "InProgress";
        return "Backlog";
    }

    private static string StripHtmlToPlain(string? html)
    {
        if (string.IsNullOrWhiteSpace(html))
            return "";
        var t = html.Trim();
        if (!t.Contains('<', StringComparison.Ordinal))
            return t;
        var noTags = Regex.Replace(t, "<br\\s*/?>", "\n", RegexOptions.IgnoreCase);
        noTags = Regex.Replace(noTags, "</p>", "\n", RegexOptions.IgnoreCase);
        noTags = Regex.Replace(noTags, "</div>", "\n", RegexOptions.IgnoreCase);
        noTags = Regex.Replace(noTags, "<.*?>", string.Empty);
        return Regex.Replace(noTags.Replace("&nbsp;", " ").Replace("&amp;", "&").Replace("&lt;", "<").Replace("&gt;", ">"), "\\n{3,}", "\n\n").Trim();
    }
}
