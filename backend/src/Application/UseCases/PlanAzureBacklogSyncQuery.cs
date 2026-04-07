namespace DevPilot.Application.UseCases;

using DevPilot.Domain.Interfaces;
using MediatR;

public record PlanAzureBacklogSyncQuery(
    Guid RepositoryId,
    Guid UserId,
    IReadOnlyList<Guid> EpicIds,
    IReadOnlyList<Guid> FeatureIds,
    IReadOnlyList<Guid> StoryIds) : IRequest<AzureBacklogSyncPlanDto>;

public class AzureBacklogSyncPlanDto
{
    public List<AzureBacklogSyncPlanItemDto> Items { get; set; } = new();
    public AzureBacklogSyncPlanSummaryDto Summary { get; set; } = new();
}

public class AzureBacklogSyncPlanItemDto
{
    public string EntityType { get; set; } = "";
    public Guid Id { get; set; }
    public string Title { get; set; } = "";
    public string? Source { get; set; }
    public int? AzureDevOpsWorkItemId { get; set; }
    /// <summary>create | push | pull — UI default; user can override before apply.</summary>
    public string SuggestedDirection { get; set; } = "";
}

public class AzureBacklogSyncPlanSummaryDto
{
    public int Create { get; set; }
    public int Push { get; set; }
    public int Pull { get; set; }
}

public class PlanAzureBacklogSyncQueryHandler : IRequestHandler<PlanAzureBacklogSyncQuery, AzureBacklogSyncPlanDto>
{
    private readonly IEpicRepository _epicRepository;
    private readonly IRepositoryRepository _repositoryRepository;

    public PlanAzureBacklogSyncQueryHandler(IEpicRepository epicRepository, IRepositoryRepository repositoryRepository)
    {
        _epicRepository = epicRepository;
        _repositoryRepository = repositoryRepository;
    }

    public async Task<AzureBacklogSyncPlanDto> Handle(PlanAzureBacklogSyncQuery request, CancellationToken cancellationToken)
    {
        var dto = new AzureBacklogSyncPlanDto();
        var repo = await _repositoryRepository.GetByIdIfAccessibleAsync(request.RepositoryId, request.UserId, cancellationToken);
        if (repo == null)
            return dto;

        var epicSel = new HashSet<Guid>(request.EpicIds);
        var featureSel = new HashSet<Guid>(request.FeatureIds);
        var storySel = new HashSet<Guid>(request.StoryIds);
        if (epicSel.Count == 0 && featureSel.Count == 0 && storySel.Count == 0)
            return dto;

        var epics = (await _epicRepository.GetByRepositoryIdAsync(request.RepositoryId, cancellationToken)).ToList();

        void AddRow(string entityType, Guid id, string title, string? source, int? adoId)
        {
            string suggested;
            if (!adoId.HasValue)
                suggested = "create";
            else if (string.Equals(source, "AzureDevOps", StringComparison.OrdinalIgnoreCase))
                suggested = "pull";
            else
                suggested = "push";

            dto.Items.Add(new AzureBacklogSyncPlanItemDto
            {
                EntityType = entityType,
                Id = id,
                Title = title,
                Source = source,
                AzureDevOpsWorkItemId = adoId,
                SuggestedDirection = suggested
            });

            switch (suggested)
            {
                case "create": dto.Summary.Create++; break;
                case "push": dto.Summary.Push++; break;
                case "pull": dto.Summary.Pull++; break;
            }
        }

        foreach (var epic in epics)
        {
            if (epicSel.Contains(epic.Id))
                AddRow("epic", epic.Id, epic.Title, epic.Source, epic.AzureDevOpsWorkItemId);

            foreach (var feature in epic.Features)
            {
                if (featureSel.Contains(feature.Id))
                    AddRow("feature", feature.Id, feature.Title, feature.Source, feature.AzureDevOpsWorkItemId);

                foreach (var story in feature.UserStories)
                {
                    if (storySel.Contains(story.Id))
                        AddRow("story", story.Id, story.Title, story.Source, story.AzureDevOpsWorkItemId);
                }
            }
        }

        return dto;
    }
}
