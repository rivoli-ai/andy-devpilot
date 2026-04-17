namespace DevPilot.Application.UseCases;

using DevPilot.Domain.Interfaces;
using MediatR;

public record PlanGitHubBacklogSyncQuery(
    Guid RepositoryId,
    Guid UserId,
    IReadOnlyList<Guid> EpicIds,
    IReadOnlyList<Guid> FeatureIds,
    IReadOnlyList<Guid> StoryIds) : IRequest<GitHubBacklogSyncPlanDto>;

public class GitHubBacklogSyncPlanDto
{
    public List<GitHubBacklogSyncPlanItemDto> Items { get; set; } = new();
    public AzureBacklogSyncPlanSummaryDto Summary { get; set; } = new();
}

public class GitHubBacklogSyncPlanItemDto
{
    public string EntityType { get; set; } = "";
    public Guid Id { get; set; }
    public string Title { get; set; } = "";
    public string? Source { get; set; }
    public int? GitHubIssueNumber { get; set; }
    /// <summary>create | push | pull — UI default; user can override before apply.</summary>
    public string SuggestedDirection { get; set; } = "";
}

public class PlanGitHubBacklogSyncQueryHandler : IRequestHandler<PlanGitHubBacklogSyncQuery, GitHubBacklogSyncPlanDto>
{
    private readonly IEpicRepository _epicRepository;
    private readonly IRepositoryRepository _repositoryRepository;

    public PlanGitHubBacklogSyncQueryHandler(IEpicRepository epicRepository, IRepositoryRepository repositoryRepository)
    {
        _epicRepository = epicRepository;
        _repositoryRepository = repositoryRepository;
    }

    public async Task<GitHubBacklogSyncPlanDto> Handle(PlanGitHubBacklogSyncQuery request, CancellationToken cancellationToken)
    {
        var dto = new GitHubBacklogSyncPlanDto();
        var repo = await _repositoryRepository.GetByIdIfAccessibleAsync(request.RepositoryId, request.UserId, cancellationToken);
        if (repo == null || !string.Equals(repo.Provider, "GitHub", StringComparison.OrdinalIgnoreCase))
            return dto;

        var epicSel = new HashSet<Guid>(request.EpicIds);
        var featureSel = new HashSet<Guid>(request.FeatureIds);
        var storySel = new HashSet<Guid>(request.StoryIds);
        if (epicSel.Count == 0 && featureSel.Count == 0 && storySel.Count == 0)
            return dto;

        var epics = (await _epicRepository.GetByRepositoryIdAsync(request.RepositoryId, cancellationToken)).ToList();

        void AddRow(string entityType, Guid id, string title, string? source, int? ghNumber)
        {
            string suggested;
            if (!ghNumber.HasValue)
                suggested = "create";
            else if (string.Equals(source, "GitHub", StringComparison.OrdinalIgnoreCase))
                suggested = "pull";
            else
                suggested = "push";

            dto.Items.Add(new GitHubBacklogSyncPlanItemDto
            {
                EntityType = entityType,
                Id = id,
                Title = title,
                Source = source,
                GitHubIssueNumber = ghNumber,
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
                AddRow("epic", epic.Id, epic.Title, epic.Source, epic.GitHubIssueNumber);

            foreach (var feature in epic.Features)
            {
                if (featureSel.Contains(feature.Id))
                    AddRow("feature", feature.Id, feature.Title, feature.Source, feature.GitHubIssueNumber);

                foreach (var story in feature.UserStories)
                {
                    if (storySel.Contains(story.Id))
                        AddRow("story", story.Id, story.Title, story.Source, story.GitHubIssueNumber);
                }
            }
        }

        return dto;
    }
}
