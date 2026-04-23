namespace DevPilot.Application.UseCases;

using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

public record PushManualBacklogToAzureDevOpsCommand(
    Guid RepositoryId,
    Guid UserId,
    string Organization,
    string ProjectName,
    string TeamId,
    IReadOnlyList<Guid> EpicIds,
    IReadOnlyList<Guid> FeatureIds,
    IReadOnlyList<Guid> StoryIds) : IRequest<PushManualBacklogToAzureDevOpsResult>;

public class PushManualBacklogToAzureDevOpsResult
{
    public bool Success { get; set; }
    public int CreatedCount { get; set; }
    public int FailedCount { get; set; }
    public List<string> Errors { get; set; } = new();
}

/// <summary>
/// Creates work items in Azure DevOps for backlog items that are not yet linked (no ADO id), scoped to the selected project/team.
/// </summary>
public class PushManualBacklogToAzureDevOpsCommandHandler : IRequestHandler<PushManualBacklogToAzureDevOpsCommand, PushManualBacklogToAzureDevOpsResult>
{
    private readonly IEpicRepository _epicRepository;
    private readonly IFeatureRepository _featureRepository;
    private readonly IUserStoryRepository _userStoryRepository;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IUserRepository _userRepository;
    private readonly IAzureDevOpsService _azureDevOpsService;
    private readonly ILogger<PushManualBacklogToAzureDevOpsCommandHandler> _logger;

    public PushManualBacklogToAzureDevOpsCommandHandler(
        IEpicRepository epicRepository,
        IFeatureRepository featureRepository,
        IUserStoryRepository userStoryRepository,
        IRepositoryRepository repositoryRepository,
        IUserRepository userRepository,
        IAzureDevOpsService azureDevOpsService,
        ILogger<PushManualBacklogToAzureDevOpsCommandHandler> logger)
    {
        _epicRepository = epicRepository;
        _featureRepository = featureRepository;
        _userStoryRepository = userStoryRepository;
        _repositoryRepository = repositoryRepository;
        _userRepository = userRepository;
        _azureDevOpsService = azureDevOpsService;
        _logger = logger;
    }

    public async Task<PushManualBacklogToAzureDevOpsResult> Handle(
        PushManualBacklogToAzureDevOpsCommand command,
        CancellationToken cancellationToken)
    {
        var result = new PushManualBacklogToAzureDevOpsResult();

        var repo = await _repositoryRepository.GetByIdIfAccessibleAsync(command.RepositoryId, command.UserId, cancellationToken);
        if (repo == null)
        {
            result.Errors.Add("Repository not found or access denied");
            return result;
        }

        var user = await _userRepository.GetByIdAsync(command.UserId, cancellationToken);
        if (user == null || string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
        {
            result.Errors.Add("Azure DevOps PAT is not configured. Add it in Settings.");
            return result;
        }

        if (string.IsNullOrWhiteSpace(user.AzureDevOpsOrganization) ||
            !string.Equals(user.AzureDevOpsOrganization.Trim(), command.Organization.Trim(), StringComparison.OrdinalIgnoreCase))
        {
            result.Errors.Add("Organization must match your Azure DevOps organization in Settings.");
            return result;
        }

        var accessToken = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
        const bool useBasicAuth = true;

        var organization = command.Organization.Trim();
        var project = command.ProjectName.Trim();
        var teamId = command.TeamId.Trim();

        var teamSettings = await _azureDevOpsService.GetTeamSettingsAsync(
            accessToken, organization, project, teamId, cancellationToken, useBasicAuth);
        if (teamSettings == null || string.IsNullOrWhiteSpace(teamSettings.DefaultAreaPath))
        {
            result.Errors.Add("Could not read team backlog settings (area path). Check project and team.");
            return result;
        }

        var types = await _azureDevOpsService.ResolveBacklogWorkItemTypesAsync(
            accessToken, organization, project, cancellationToken, useBasicAuth);
        if (string.IsNullOrEmpty(types.EpicTypeName) || string.IsNullOrEmpty(types.FeatureTypeName) ||
            string.IsNullOrEmpty(types.StoryTypeName))
        {
            result.Errors.Add(
                "This process template does not include Epic, Feature, and User Story (or Product Backlog Item). Use an Agile or Scrum-style project.");
            return result;
        }

        var stateCache = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        async Task<string?> InitialStateAsync(string wit)
        {
            if (stateCache.TryGetValue(wit, out var c)) return c;
            var states = await _azureDevOpsService.GetWorkItemTypeStatesAsync(
                accessToken, organization, project, wit, cancellationToken, useBasicAuth);
            var pick = states.FirstOrDefault(s =>
                string.Equals(s.Category, "Proposed", StringComparison.OrdinalIgnoreCase)) ?? states.FirstOrDefault();
            var name = pick?.Name;
            stateCache[wit] = name;
            return name;
        }

        var epicSel = new HashSet<Guid>(command.EpicIds);
        var featSel = new HashSet<Guid>(command.FeatureIds);
        var storySel = new HashSet<Guid>(command.StoryIds);

        var epics = (await _epicRepository.GetByRepositoryIdAsync(command.RepositoryId, cancellationToken)).ToList();

        bool EpicInScope(Epic e) =>
            epicSel.Contains(e.Id) ||
            e.Features.Any(f => featSel.Contains(f.Id) || f.UserStories.Any(s => storySel.Contains(s.Id)));

        bool FeatureInScope(Feature f) =>
            featSel.Contains(f.Id) || f.UserStories.Any(s => storySel.Contains(s.Id));

        bool StoryInScope(UserStory s) => storySel.Contains(s.Id);

        foreach (var epic in epics)
        {
            if (!EpicInScope(epic)) continue;

            if (!epic.AzureDevOpsWorkItemId.HasValue)
            {
                try
                {
                    var patches = BuildBasePatches(epic.Title, epic.Description, teamSettings, await InitialStateAsync(types.EpicTypeName!));
                    var id = await _azureDevOpsService.CreateWorkItemAsync(
                        accessToken, organization, project, types.EpicTypeName!, patches, null, cancellationToken, useBasicAuth);
                    epic.SetAzureDevOpsWorkItemId(id);
                    epic.SetSource("AzureDevOps");
                    await _epicRepository.UpdateAsync(epic, cancellationToken);
                    result.CreatedCount++;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Create ADO epic for {EpicId}", epic.Id);
                    result.FailedCount++;
                    result.Errors.Add($"Epic '{epic.Title}': {ex.Message}");
                }
            }

            foreach (var feature in epic.Features)
            {
                if (!FeatureInScope(feature)) continue;

                if (!epic.AzureDevOpsWorkItemId.HasValue)
                {
                    result.FailedCount++;
                    result.Errors.Add($"Feature '{feature.Title}': parent epic is not linked to Azure DevOps.");
                    continue;
                }

                if (!feature.AzureDevOpsWorkItemId.HasValue)
                {
                    try
                    {
                        var patches = BuildBasePatches(feature.Title, feature.Description, teamSettings, await InitialStateAsync(types.FeatureTypeName!));
                        var id = await _azureDevOpsService.CreateWorkItemAsync(
                            accessToken, organization, project, types.FeatureTypeName!, patches, epic.AzureDevOpsWorkItemId, cancellationToken, useBasicAuth);
                        feature.SetAzureDevOpsWorkItemId(id);
                        feature.SetSource("AzureDevOps");
                        await _featureRepository.UpdateAsync(feature, cancellationToken);
                        result.CreatedCount++;
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Create ADO feature for {FeatureId}", feature.Id);
                        result.FailedCount++;
                        result.Errors.Add($"Feature '{feature.Title}': {ex.Message}");
                    }
                }

                foreach (var story in feature.UserStories)
                {
                    if (!StoryInScope(story)) continue;

                    if (!feature.AzureDevOpsWorkItemId.HasValue)
                    {
                        result.FailedCount++;
                        result.Errors.Add($"Story '{story.Title}': parent feature is not linked to Azure DevOps.");
                        continue;
                    }

                    if (!story.AzureDevOpsWorkItemId.HasValue)
                    {
                        try
                        {
                            var patches = BuildBasePatches(story.Title, story.Description, teamSettings, await InitialStateAsync(types.StoryTypeName!));
                            if (story.StoryPoints.HasValue)
                            {
                                patches.Add(new AzureDevOpsWorkItemPatchOperation
                                {
                                    Op = "add",
                                    Path = "/fields/Microsoft.VSTS.Scheduling.StoryPoints",
                                    Value = (double)story.StoryPoints.Value
                                });
                            }

                            if (!string.IsNullOrWhiteSpace(story.AcceptanceCriteria))
                            {
                                patches.Add(new AzureDevOpsWorkItemPatchOperation
                                {
                                    Op = "add",
                                    Path = "/fields/Microsoft.VSTS.Common.AcceptanceCriteria",
                                    Value = ConvertAcToHtml(story.AcceptanceCriteria)
                                });
                            }

                            var id = await _azureDevOpsService.CreateWorkItemAsync(
                                accessToken, organization, project, types.StoryTypeName!, patches, feature.AzureDevOpsWorkItemId, cancellationToken, useBasicAuth);
                            story.SetAzureDevOpsWorkItemId(id);
                            story.SetSource("AzureDevOps");
                            await _userStoryRepository.UpdateAsync(story, cancellationToken);
                            result.CreatedCount++;
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex, "Create ADO story for {StoryId}", story.Id);
                            result.FailedCount++;
                            result.Errors.Add($"Story '{story.Title}': {ex.Message}");
                        }
                    }
                }
            }
        }

        if (result.CreatedCount == 0 && result.FailedCount == 0)
            result.Errors.Add("Nothing to create: selected items may already be linked to Azure DevOps.");

        result.Success = result.FailedCount == 0;
        return result;
    }

    private static List<AzureDevOpsWorkItemPatchOperation> BuildBasePatches(
        string title,
        string? description,
        AzureDevOpsTeamSettingsDto ts,
        string? state)
    {
        var list = new List<AzureDevOpsWorkItemPatchOperation>
        {
            new() { Op = "add", Path = "/fields/System.Title", Value = title ?? "" },
            new() { Op = "add", Path = "/fields/System.AreaPath", Value = ts.DefaultAreaPath ?? "" }
        };
        // Do not set System.IterationPath on create. Even paths from team settings / Iterations
        // classification can be rejected as TF401347 "Invalid tree name" for the WIT store; Azure
        // applies the team default iteration when this field is omitted.
        if (!string.IsNullOrWhiteSpace(description))
            list.Add(new AzureDevOpsWorkItemPatchOperation { Op = "add", Path = "/fields/System.Description", Value = ConvertToHtml(description) });
        if (!string.IsNullOrWhiteSpace(state))
            list.Add(new AzureDevOpsWorkItemPatchOperation { Op = "add", Path = "/fields/System.State", Value = state });
        return list;
    }

    private static string ConvertToHtml(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return text;
        var trimmed = text.Trim();
        if (trimmed.StartsWith('<') && trimmed.Contains("</", StringComparison.Ordinal)) return text;
        var escaped = System.Net.WebUtility.HtmlEncode(text);
        var lines = escaped.Split('\n');
        var sb = new System.Text.StringBuilder();
        foreach (var line in lines)
        {
            var t = line.TrimEnd('\r');
            if (string.IsNullOrWhiteSpace(t)) sb.Append("<br>");
            else sb.Append("<div>").Append(t).Append("</div>");
        }
        return sb.ToString();
    }

    private static string ConvertAcToHtml(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return text;
        var trimmed = text.Trim();
        if (trimmed.StartsWith('<') && trimmed.Contains("</", StringComparison.Ordinal)) return text;
        var escaped = System.Net.WebUtility.HtmlEncode(text.Trim());
        return "<ul><li>" + escaped + "</li></ul>";
    }
}
