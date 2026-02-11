namespace DevPilot.Application.UseCases;

using System.Security.Claims;
using DevPilot.Application.Services;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

public record SyncBacklogToAzureDevOpsCommand(
    Guid RepositoryId,
    Guid UserId,
    IReadOnlyList<Guid> EpicIds,
    IReadOnlyList<Guid> FeatureIds,
    IReadOnlyList<Guid> StoryIds) : IRequest<SyncBacklogToAzureDevOpsResult>;

public class SyncBacklogToAzureDevOpsResult
{
    public bool Success { get; set; }
    public int SyncedCount { get; set; }
    public int FailedCount { get; set; }
    public List<string> Errors { get; set; } = new();
}

/// <summary>
/// Syncs backlog items (Epics, Features, User Stories) that were imported from Azure DevOps
/// back to Azure DevOps with current title, description, status, etc.
/// </summary>
public class SyncBacklogToAzureDevOpsCommandHandler : IRequestHandler<SyncBacklogToAzureDevOpsCommand, SyncBacklogToAzureDevOpsResult>
{
    private readonly IEpicRepository _epicRepository;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IUserRepository _userRepository;
    private readonly IAzureDevOpsService _azureDevOpsService;
    private readonly ILogger<SyncBacklogToAzureDevOpsCommandHandler> _logger;

    public SyncBacklogToAzureDevOpsCommandHandler(
        IEpicRepository epicRepository,
        IRepositoryRepository repositoryRepository,
        IUserRepository userRepository,
        IAzureDevOpsService azureDevOpsService,
        ILogger<SyncBacklogToAzureDevOpsCommandHandler> logger)
    {
        _epicRepository = epicRepository ?? throw new ArgumentNullException(nameof(epicRepository));
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
        _azureDevOpsService = azureDevOpsService ?? throw new ArgumentNullException(nameof(azureDevOpsService));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<SyncBacklogToAzureDevOpsResult> Handle(
        SyncBacklogToAzureDevOpsCommand command,
        CancellationToken cancellationToken)
    {
        var result = new SyncBacklogToAzureDevOpsResult();

        var repository = await _repositoryRepository.GetByIdAsync(command.RepositoryId, cancellationToken);
        if (repository == null)
        {
            result.Success = false;
            result.Errors.Add($"Repository {command.RepositoryId} not found");
            return result;
        }

        if (repository.Provider != "AzureDevOps")
        {
            result.Success = false;
            result.Errors.Add("Repository is not from Azure DevOps. Sync is only supported for Azure DevOps repositories.");
            return result;
        }

        // Parse org and project from FullName: "org/project/repo"
        var parts = repository.FullName.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2)
        {
            result.Success = false;
            result.Errors.Add($"Repository full name '{repository.FullName}' is invalid. Expected format: org/project/repo");
            return result;
        }

        var organization = parts[0];
        var project = parts[1];

        var user = await _userRepository.GetByIdAsync(command.UserId, cancellationToken);
        if (user == null)
        {
            result.Success = false;
            result.Errors.Add("User not found");
            return result;
        }

        string accessToken;
        bool useBasicAuth = false;

        if (!string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
        {
            var credentials = Convert.ToBase64String(
                System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
            accessToken = credentials;
            useBasicAuth = true;
        }
        else
        {
            result.Success = false;
            result.Errors.Add("Azure DevOps access token is not configured. Please set it in Settings.");
            return result;
        }

        var epics = await _epicRepository.GetByRepositoryIdAsync(command.RepositoryId, cancellationToken);
        var itemsToSync = new List<(int AdoId, string Title, string? Description, string Status, int? StoryPoints, string? AcceptanceCriteria)>();

        var epicIdsSet = command.EpicIds.Count > 0 ? new HashSet<Guid>(command.EpicIds) : null;
        var featureIdsSet = command.FeatureIds.Count > 0 ? new HashSet<Guid>(command.FeatureIds) : null;
        var storyIdsSet = command.StoryIds.Count > 0 ? new HashSet<Guid>(command.StoryIds) : null;
        var filterBySelection = epicIdsSet != null || featureIdsSet != null || storyIdsSet != null;

        foreach (var epic in epics.Where(e => e.Source == "AzureDevOps" && e.AzureDevOpsWorkItemId.HasValue))
        {
            if (filterBySelection && (epicIdsSet == null || !epicIdsSet.Contains(epic.Id)))
                continue;
            itemsToSync.Add((epic.AzureDevOpsWorkItemId!.Value, epic.Title, epic.Description, epic.Status, null, null));
        }

        foreach (var epic in epics)
        {
            foreach (var feature in epic.Features.Where(f => f.Source == "AzureDevOps" && f.AzureDevOpsWorkItemId.HasValue))
            {
                if (filterBySelection && (featureIdsSet == null || !featureIdsSet.Contains(feature.Id)))
                    continue;
                itemsToSync.Add((feature.AzureDevOpsWorkItemId!.Value, feature.Title, feature.Description, feature.Status, null, null));
            }

            foreach (var feature in epic.Features)
            {
                foreach (var story in feature.UserStories.Where(s => s.Source == "AzureDevOps" && s.AzureDevOpsWorkItemId.HasValue))
                {
                    if (filterBySelection && (storyIdsSet == null || !storyIdsSet.Contains(story.Id)))
                        continue;
                    itemsToSync.Add((story.AzureDevOpsWorkItemId!.Value, story.Title, story.Description, story.Status, story.StoryPoints, story.AcceptanceCriteria));
                }
            }
        }

        if (itemsToSync.Count == 0)
        {
            result.Success = true;
            result.SyncedCount = 0;
            result.Errors.Add("No items with Azure DevOps link found to sync.");
            return result;
        }

        // Fetch work item types from ADO (each item may be Epic, Feature, User Story, or Product Backlog Item)
        var adoIds = itemsToSync.Select(x => x.AdoId).Distinct().ToList();
        var workItemTypesById = await _azureDevOpsService.GetWorkItemTypesByIdsAsync(
            accessToken, organization, project, adoIds, cancellationToken, useBasicAuth);

        // Cache allowed states per work item type
        var statesByType = new Dictionary<string, IReadOnlyList<AzureDevOpsWorkItemStateDto>>(StringComparer.OrdinalIgnoreCase);

        string? MapStatusToAdoState(string appStatus, string workItemType)
        {
            if (string.IsNullOrWhiteSpace(appStatus)) return null;
            if (!statesByType.TryGetValue(workItemType, out var states) || states.Count == 0) return null;

            // Map app status to ADO category: Proposed, InProgress, Resolved, Completed
            var normalized = appStatus.Trim().Replace(" ", "").ToLowerInvariant();
            var category = normalized switch
            {
                "backlog" => "Proposed",
                "inprogress" or "pendingreview" => "InProgress",
                "done" or "implemented" or "resolved" => "Completed",
                _ => null
            };
            if (category == null) return null;

            // Prefer Completed, fallback to Resolved for done-like states
            if (category == "Completed")
            {
                var completed = states.FirstOrDefault(s => string.Equals(s.Category, "Completed", StringComparison.OrdinalIgnoreCase));
                if (completed != null) return completed.Name;
                var resolved = states.FirstOrDefault(s => string.Equals(s.Category, "Resolved", StringComparison.OrdinalIgnoreCase));
                return resolved?.Name;
            }

            var match = states.FirstOrDefault(s => string.Equals(s.Category, category, StringComparison.OrdinalIgnoreCase));
            return match?.Name;
        }

        foreach (var (adoId, title, description, status, storyPoints, acceptanceCriteria) in itemsToSync)
        {
            try
            {
                var patches = new List<AzureDevOpsWorkItemPatchOperation>();

                patches.Add(new AzureDevOpsWorkItemPatchOperation { Op = "add", Path = "/fields/System.Title", Value = title ?? "" });

                if (description != null)
                {
                    patches.Add(new AzureDevOpsWorkItemPatchOperation { Op = "add", Path = "/fields/System.Description", Value = description });
                }

                // Sync status -> System.State using allowed values from ADO
                var workItemType = workItemTypesById.TryGetValue(adoId, out var wt) ? wt : null;
                if (!string.IsNullOrEmpty(workItemType))
                {
                    if (!statesByType.ContainsKey(workItemType))
                    {
                        var states = await _azureDevOpsService.GetWorkItemTypeStatesAsync(
                            accessToken, organization, project, workItemType, cancellationToken, useBasicAuth);
                        statesByType[workItemType] = states;
                    }

                    var adoState = MapStatusToAdoState(status, workItemType);
                    if (!string.IsNullOrEmpty(adoState))
                    {
                        patches.Add(new AzureDevOpsWorkItemPatchOperation { Op = "add", Path = "/fields/System.State", Value = adoState });
                    }
                }

                // Story points only for User Story / Product Backlog Item (add creates or updates)
                if (storyPoints.HasValue && !string.IsNullOrEmpty(workItemType) &&
                    (workItemType.Equals("User Story", StringComparison.OrdinalIgnoreCase) || workItemType.Equals("Product Backlog Item", StringComparison.OrdinalIgnoreCase)))
                {
                    patches.Add(new AzureDevOpsWorkItemPatchOperation { Op = "add", Path = "/fields/Microsoft.VSTS.Scheduling.StoryPoints", Value = (double)storyPoints.Value });
                }

                if (!string.IsNullOrEmpty(acceptanceCriteria))
                {
                    patches.Add(new AzureDevOpsWorkItemPatchOperation { Op = "add", Path = "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", Value = acceptanceCriteria });
                }

                await _azureDevOpsService.UpdateWorkItemAsync(
                    accessToken, organization, project, adoId, patches, cancellationToken, useBasicAuth);

                result.SyncedCount++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to sync work item {AdoId} to Azure DevOps", adoId);
                result.FailedCount++;
                result.Errors.Add($"Failed to sync work item {adoId} ({title}): {ex.Message}");
            }
        }

        result.Success = result.FailedCount == 0;
        _logger.LogInformation("Sync to Azure DevOps completed. Synced: {Synced}, Failed: {Failed}",
            result.SyncedCount, result.FailedCount);

        return result;
    }
}
