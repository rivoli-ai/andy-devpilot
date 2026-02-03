namespace DevPilot.Application.UseCases;

using DevPilot.Application.DTOs;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

// Add Epic
public record AddEpicCommand(Guid RepositoryId, string Title, string? Description = null) : IRequest<EpicDto>;

public class AddEpicCommandHandler : IRequestHandler<AddEpicCommand, EpicDto>
{
    private readonly IEpicRepository _epicRepository;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly ILogger<AddEpicCommandHandler> _logger;

    public AddEpicCommandHandler(
        IEpicRepository epicRepository,
        IRepositoryRepository repositoryRepository,
        ILogger<AddEpicCommandHandler> logger)
    {
        _epicRepository = epicRepository ?? throw new ArgumentNullException(nameof(epicRepository));
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<EpicDto> Handle(AddEpicCommand command, CancellationToken cancellationToken)
    {
        var repo = await _repositoryRepository.GetByIdAsync(command.RepositoryId, cancellationToken);
        if (repo == null)
            throw new InvalidOperationException($"Repository {command.RepositoryId} not found");

        var epic = new Epic(command.Title, command.RepositoryId, command.Description);
        epic = await _epicRepository.AddAsync(epic, cancellationToken);
        _logger.LogInformation("Added Epic {EpicId}: {Title}", epic.Id, epic.Title);

        return new EpicDto
        {
            Id = epic.Id,
            Title = epic.Title,
            Description = epic.Description,
            RepositoryId = epic.RepositoryId,
            Status = epic.Status,
            CreatedAt = epic.CreatedAt,
            UpdatedAt = epic.UpdatedAt,
            Features = []
        };
    }
}

// Add Feature
public record AddFeatureCommand(Guid EpicId, string Title, string? Description = null) : IRequest<FeatureDto>;

public class AddFeatureCommandHandler : IRequestHandler<AddFeatureCommand, FeatureDto>
{
    private readonly IFeatureRepository _featureRepository;
    private readonly IEpicRepository _epicRepository;
    private readonly ILogger<AddFeatureCommandHandler> _logger;

    public AddFeatureCommandHandler(
        IFeatureRepository featureRepository,
        IEpicRepository epicRepository,
        ILogger<AddFeatureCommandHandler> logger)
    {
        _featureRepository = featureRepository ?? throw new ArgumentNullException(nameof(featureRepository));
        _epicRepository = epicRepository ?? throw new ArgumentNullException(nameof(epicRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<FeatureDto> Handle(AddFeatureCommand command, CancellationToken cancellationToken)
    {
        var epic = await _epicRepository.GetByIdAsync(command.EpicId, cancellationToken);
        if (epic == null)
            throw new InvalidOperationException($"Epic {command.EpicId} not found");

        var feature = new Feature(command.Title, command.EpicId, command.Description);
        feature = await _featureRepository.AddAsync(feature, cancellationToken);
        _logger.LogInformation("Added Feature {FeatureId}: {Title} to Epic {EpicId}", feature.Id, feature.Title, command.EpicId);

        return new FeatureDto
        {
            Id = feature.Id,
            Title = feature.Title,
            Description = feature.Description,
            EpicId = feature.EpicId,
            Status = feature.Status,
            CreatedAt = feature.CreatedAt,
            UpdatedAt = feature.UpdatedAt,
            UserStories = []
        };
    }
}

// Add User Story
public record AddUserStoryCommand(Guid FeatureId, string Title, string? Description = null, string? AcceptanceCriteria = null, int? StoryPoints = null) : IRequest<UserStoryDto>;

public class AddUserStoryCommandHandler : IRequestHandler<AddUserStoryCommand, UserStoryDto>
{
    private readonly IUserStoryRepository _userStoryRepository;
    private readonly IFeatureRepository _featureRepository;
    private readonly ILogger<AddUserStoryCommandHandler> _logger;

    public AddUserStoryCommandHandler(
        IUserStoryRepository userStoryRepository,
        IFeatureRepository featureRepository,
        ILogger<AddUserStoryCommandHandler> logger)
    {
        _userStoryRepository = userStoryRepository ?? throw new ArgumentNullException(nameof(userStoryRepository));
        _featureRepository = featureRepository ?? throw new ArgumentNullException(nameof(featureRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<UserStoryDto> Handle(AddUserStoryCommand command, CancellationToken cancellationToken)
    {
        var feature = await _featureRepository.GetByIdAsync(command.FeatureId, cancellationToken);
        if (feature == null)
            throw new InvalidOperationException($"Feature {command.FeatureId} not found");

        var userStory = new UserStory(command.Title, command.FeatureId, command.Description, command.AcceptanceCriteria, command.StoryPoints);
        userStory = await _userStoryRepository.AddAsync(userStory, cancellationToken);
        _logger.LogInformation("Added UserStory {StoryId}: {Title} to Feature {FeatureId}", userStory.Id, userStory.Title, command.FeatureId);

        return new UserStoryDto
        {
            Id = userStory.Id,
            Title = userStory.Title,
            Description = userStory.Description,
            FeatureId = userStory.FeatureId,
            Status = userStory.Status,
            AcceptanceCriteria = userStory.AcceptanceCriteria,
            StoryPoints = userStory.StoryPoints,
            CreatedAt = userStory.CreatedAt,
            UpdatedAt = userStory.UpdatedAt,
            Tasks = []
        };
    }
}
