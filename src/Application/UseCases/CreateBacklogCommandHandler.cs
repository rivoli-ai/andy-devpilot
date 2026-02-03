namespace DevPilot.Application.UseCases;

using DevPilot.Application.DTOs;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

/// <summary>
/// Request model for creating a backlog from AI-generated data
/// </summary>
public class CreateBacklogRequest
{
    public List<CreateEpicRequest> Epics { get; set; } = new();
}

public class CreateEpicRequest
{
    public string Title { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public List<CreateFeatureRequest> Features { get; set; } = new();
}

public class CreateFeatureRequest
{
    public string Title { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public List<CreateUserStoryRequest> UserStories { get; set; } = new();
}

public class CreateUserStoryRequest
{
    public string Title { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public List<string> AcceptanceCriteria { get; set; } = new();
    public int? StoryPoints { get; set; }
}

/// <summary>
/// Command to create a backlog from AI-generated data
/// </summary>
public record CreateBacklogCommand(Guid RepositoryId, CreateBacklogRequest Request) : IRequest<IEnumerable<EpicDto>>;

/// <summary>
/// Handler for CreateBacklogCommand
/// Creates Epics, Features, and User Stories from AI-generated backlog data
/// </summary>
public class CreateBacklogCommandHandler : IRequestHandler<CreateBacklogCommand, IEnumerable<EpicDto>>
{
    private readonly IEpicRepository _epicRepository;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly ILogger<CreateBacklogCommandHandler> _logger;

    public CreateBacklogCommandHandler(
        IEpicRepository epicRepository,
        IRepositoryRepository repositoryRepository,
        ILogger<CreateBacklogCommandHandler> logger)
    {
        _epicRepository = epicRepository ?? throw new ArgumentNullException(nameof(epicRepository));
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<IEnumerable<EpicDto>> Handle(
        CreateBacklogCommand command,
        CancellationToken cancellationToken)
    {
        _logger.LogInformation("Creating backlog for repository {RepositoryId}", command.RepositoryId);

        // Verify repository exists
        var repository = await _repositoryRepository.GetByIdAsync(command.RepositoryId, cancellationToken);
        if (repository == null)
        {
            throw new InvalidOperationException($"Repository with ID {command.RepositoryId} not found");
        }

        var createdEpics = new List<Epic>();

        foreach (var epicRequest in command.Request.Epics)
        {
            // Create Epic
            var epic = new Epic(
                epicRequest.Title,
                command.RepositoryId,
                epicRequest.Description
            );

            // Add Features
            foreach (var featureRequest in epicRequest.Features)
            {
                var feature = new Feature(
                    featureRequest.Title,
                    epic.Id,
                    featureRequest.Description
                );

                // Add User Stories
                foreach (var userStoryRequest in featureRequest.UserStories)
                {
                    var acceptanceCriteria = userStoryRequest.AcceptanceCriteria != null 
                        ? string.Join("\n- ", userStoryRequest.AcceptanceCriteria)
                        : null;

                    var userStory = new UserStory(
                        userStoryRequest.Title,
                        feature.Id,
                        userStoryRequest.Description,
                        acceptanceCriteria,
                        userStoryRequest.StoryPoints
                    );

                    feature.UserStories.Add(userStory);
                }

                epic.Features.Add(feature);
            }

            // Save Epic (cascade saves Features and User Stories via navigation properties)
            await _epicRepository.AddAsync(epic, cancellationToken);
            createdEpics.Add(epic);

            _logger.LogInformation("Created Epic '{Title}' with {FeatureCount} features", 
                epic.Title, epic.Features.Count);
        }

        _logger.LogInformation("Successfully created {EpicCount} epics for repository {RepositoryId}", 
            createdEpics.Count, command.RepositoryId);

        // Return DTOs
        return createdEpics.Select(MapEpicToDto);
    }

    private EpicDto MapEpicToDto(Epic epic)
    {
        return new EpicDto
        {
            Id = epic.Id,
            Title = epic.Title,
            Description = epic.Description,
            RepositoryId = epic.RepositoryId,
            Status = epic.Status,
            CreatedAt = epic.CreatedAt,
            UpdatedAt = epic.UpdatedAt,
            Features = epic.Features.Select(f => new FeatureDto
            {
                Id = f.Id,
                Title = f.Title,
                Description = f.Description,
                EpicId = f.EpicId,
                Status = f.Status,
                CreatedAt = f.CreatedAt,
                UpdatedAt = f.UpdatedAt,
                UserStories = f.UserStories.Select(us => new UserStoryDto
                {
                    Id = us.Id,
                    Title = us.Title,
                    Description = us.Description,
                    FeatureId = us.FeatureId,
                    Status = us.Status,
                    AcceptanceCriteria = us.AcceptanceCriteria,
                    PrUrl = us.PrUrl,
                    StoryPoints = us.StoryPoints,
                    CreatedAt = us.CreatedAt,
                    UpdatedAt = us.UpdatedAt,
                    Tasks = new List<TaskDto>()
                }).ToList()
            }).ToList()
        };
    }
}
