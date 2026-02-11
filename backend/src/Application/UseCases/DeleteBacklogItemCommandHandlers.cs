namespace DevPilot.Application.UseCases;

using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

public record DeleteEpicCommand(Guid EpicId) : IRequest<bool>;

public class DeleteEpicCommandHandler : IRequestHandler<DeleteEpicCommand, bool>
{
    private readonly IEpicRepository _epicRepository;
    private readonly ILogger<DeleteEpicCommandHandler> _logger;

    public DeleteEpicCommandHandler(IEpicRepository epicRepository, ILogger<DeleteEpicCommandHandler> logger)
    {
        _epicRepository = epicRepository ?? throw new ArgumentNullException(nameof(epicRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<bool> Handle(DeleteEpicCommand command, CancellationToken cancellationToken)
    {
        var epic = await _epicRepository.GetByIdAsync(command.EpicId, cancellationToken);
        if (epic == null) return false;
        await _epicRepository.DeleteAsync(epic, cancellationToken);
        _logger.LogInformation("Deleted Epic {EpicId}", command.EpicId);
        return true;
    }
}

public record DeleteFeatureCommand(Guid FeatureId) : IRequest<bool>;

public class DeleteFeatureCommandHandler : IRequestHandler<DeleteFeatureCommand, bool>
{
    private readonly IFeatureRepository _featureRepository;
    private readonly ILogger<DeleteFeatureCommandHandler> _logger;

    public DeleteFeatureCommandHandler(IFeatureRepository featureRepository, ILogger<DeleteFeatureCommandHandler> logger)
    {
        _featureRepository = featureRepository ?? throw new ArgumentNullException(nameof(featureRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<bool> Handle(DeleteFeatureCommand command, CancellationToken cancellationToken)
    {
        var feature = await _featureRepository.GetByIdAsync(command.FeatureId, cancellationToken);
        if (feature == null) return false;
        await _featureRepository.DeleteAsync(feature, cancellationToken);
        _logger.LogInformation("Deleted Feature {FeatureId}", command.FeatureId);
        return true;
    }
}

public record DeleteUserStoryCommand(Guid StoryId) : IRequest<bool>;

public class DeleteUserStoryCommandHandler : IRequestHandler<DeleteUserStoryCommand, bool>
{
    private readonly IUserStoryRepository _userStoryRepository;
    private readonly ILogger<DeleteUserStoryCommandHandler> _logger;

    public DeleteUserStoryCommandHandler(IUserStoryRepository userStoryRepository, ILogger<DeleteUserStoryCommandHandler> logger)
    {
        _userStoryRepository = userStoryRepository ?? throw new ArgumentNullException(nameof(userStoryRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<bool> Handle(DeleteUserStoryCommand command, CancellationToken cancellationToken)
    {
        var story = await _userStoryRepository.GetByIdAsync(command.StoryId, cancellationToken);
        if (story == null) return false;
        await _userStoryRepository.DeleteAsync(story, cancellationToken);
        _logger.LogInformation("Deleted UserStory {StoryId}", command.StoryId);
        return true;
    }
}
