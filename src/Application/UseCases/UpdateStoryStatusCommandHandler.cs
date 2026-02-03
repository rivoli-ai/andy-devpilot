namespace DevPilot.Application.UseCases;

using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

/// <summary>
/// Command to update a user story's status
/// </summary>
public record UpdateStoryStatusCommand(Guid StoryId, string Status, string? PrUrl = null) : IRequest<bool>;

/// <summary>
/// Handler for UpdateStoryStatusCommand
/// Updates the status of a user story (e.g., after PR is created)
/// </summary>
public class UpdateStoryStatusCommandHandler : IRequestHandler<UpdateStoryStatusCommand, bool>
{
    private readonly IUserStoryRepository _userStoryRepository;
    private readonly ILogger<UpdateStoryStatusCommandHandler> _logger;

    // Valid statuses for a user story
    // Backlog (0%) -> InProgress (25%) -> PendingReview (50%, PR created) -> Done (100%, PR merged)
    private static readonly HashSet<string> ValidStatuses = new(StringComparer.OrdinalIgnoreCase)
    {
        "Backlog",
        "InProgress", 
        "PendingReview", // PR created but not yet merged
        "Done",
        "Implemented"
    };

    public UpdateStoryStatusCommandHandler(
        IUserStoryRepository userStoryRepository,
        ILogger<UpdateStoryStatusCommandHandler> logger)
    {
        _userStoryRepository = userStoryRepository ?? throw new ArgumentNullException(nameof(userStoryRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<bool> Handle(
        UpdateStoryStatusCommand command,
        CancellationToken cancellationToken)
    {
        _logger.LogInformation("Updating status for story {StoryId} to {Status}", command.StoryId, command.Status);

        // Validate status
        if (!ValidStatuses.Contains(command.Status))
        {
            _logger.LogWarning("Invalid status '{Status}' for story {StoryId}", command.Status, command.StoryId);
            throw new ArgumentException($"Invalid status '{command.Status}'. Valid values are: {string.Join(", ", ValidStatuses)}");
        }

        // Get the user story
        var userStory = await _userStoryRepository.GetByIdAsync(command.StoryId, cancellationToken);
        if (userStory == null)
        {
            _logger.LogWarning("Story {StoryId} not found", command.StoryId);
            return false;
        }

        // Update the status and optionally the PR URL
        userStory.ChangeStatus(command.Status, command.PrUrl);
        await _userStoryRepository.UpdateAsync(userStory, cancellationToken);

        _logger.LogInformation("Successfully updated story {StoryId} status to {Status}, PR URL: {PrUrl}", 
            command.StoryId, command.Status, command.PrUrl ?? "none");
        return true;
    }
}
