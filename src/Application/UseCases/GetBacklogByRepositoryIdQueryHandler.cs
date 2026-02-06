namespace DevPilot.Application.UseCases;

using DevPilot.Application.DTOs;
using DevPilot.Application.Queries;
using DevPilot.Domain.Interfaces;
using MediatR;

/// <summary>
/// Handler for GetBacklogByRepositoryIdQuery
/// Returns all Epics with their Features and User Stories for a repository
/// </summary>
public class GetBacklogByRepositoryIdQueryHandler : IRequestHandler<GetBacklogByRepositoryIdQuery, IEnumerable<EpicDto>>
{
    private readonly IEpicRepository _epicRepository;

    public GetBacklogByRepositoryIdQueryHandler(IEpicRepository epicRepository)
    {
        _epicRepository = epicRepository ?? throw new ArgumentNullException(nameof(epicRepository));
    }

    public async System.Threading.Tasks.Task<IEnumerable<EpicDto>> Handle(
        GetBacklogByRepositoryIdQuery request,
        CancellationToken cancellationToken)
    {
        var epics = await _epicRepository.GetByRepositoryIdAsync(request.RepositoryId, cancellationToken);

        return epics.Select(e => MapEpicToDto(e));
    }

    private EpicDto MapEpicToDto(Domain.Entities.Epic epic)
    {
        return new EpicDto
        {
            Id = epic.Id,
            Title = epic.Title,
            Description = epic.Description,
            RepositoryId = epic.RepositoryId,
            Status = epic.Status,
            Source = epic.Source,
            AzureDevOpsWorkItemId = epic.AzureDevOpsWorkItemId,
            CreatedAt = epic.CreatedAt,
            UpdatedAt = epic.UpdatedAt,
            Features = epic.Features.Select(f => MapFeatureToDto(f)).ToList()
        };
    }

    private FeatureDto MapFeatureToDto(Domain.Entities.Feature feature)
    {
        return new FeatureDto
        {
            Id = feature.Id,
            Title = feature.Title,
            Description = feature.Description,
            EpicId = feature.EpicId,
            Status = feature.Status,
            Source = feature.Source,
            AzureDevOpsWorkItemId = feature.AzureDevOpsWorkItemId,
            CreatedAt = feature.CreatedAt,
            UpdatedAt = feature.UpdatedAt,
            UserStories = feature.UserStories.Select(us => MapUserStoryToDto(us)).ToList()
        };
    }

    private UserStoryDto MapUserStoryToDto(Domain.Entities.UserStory userStory)
    {
        return new UserStoryDto
        {
            Id = userStory.Id,
            Title = userStory.Title,
            Description = userStory.Description,
            FeatureId = userStory.FeatureId,
            Status = userStory.Status,
            AcceptanceCriteria = userStory.AcceptanceCriteria,
            PrUrl = userStory.PrUrl,
            StoryPoints = userStory.StoryPoints,
            Source = userStory.Source,
            AzureDevOpsWorkItemId = userStory.AzureDevOpsWorkItemId,
            CreatedAt = userStory.CreatedAt,
            UpdatedAt = userStory.UpdatedAt,
            Tasks = userStory.Tasks.Select(t => MapTaskToDto(t)).ToList()
        };
    }

    private TaskDto MapTaskToDto(Domain.Entities.Task task)
    {
        return new TaskDto
        {
            Id = task.Id,
            Title = task.Title,
            Description = task.Description,
            UserStoryId = task.UserStoryId,
            Status = task.Status,
            Complexity = task.Complexity,
            AssignedTo = task.AssignedTo,
            CreatedAt = task.CreatedAt,
            UpdatedAt = task.UpdatedAt
        };
    }
}
