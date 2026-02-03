namespace DevPilot.API.Controllers;

using DevPilot.Application.Queries;
using DevPilot.Application.UseCases;
using DevPilot.Application.Services;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Authorization;

/// <summary>
/// Controller for managing backlog (Epics, Features, User Stories)
/// Follows Clean Architecture - no business logic, only delegates to Application layer
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class BacklogController : ControllerBase
{
    private readonly IMediator _mediator;
    private readonly ILogger<BacklogController> _logger;
    private readonly IGitHubService _gitHubService;
    private readonly IUserStoryRepository _userStoryRepository;
    private readonly IEpicRepository _epicRepository;
    private readonly IFeatureRepository _featureRepository;

    public BacklogController(
        IMediator mediator, 
        ILogger<BacklogController> logger,
        IGitHubService gitHubService,
        IUserStoryRepository userStoryRepository,
        IEpicRepository epicRepository,
        IFeatureRepository featureRepository)
    {
        _mediator = mediator ?? throw new ArgumentNullException(nameof(mediator));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _gitHubService = gitHubService ?? throw new ArgumentNullException(nameof(gitHubService));
        _userStoryRepository = userStoryRepository ?? throw new ArgumentNullException(nameof(userStoryRepository));
        _epicRepository = epicRepository ?? throw new ArgumentNullException(nameof(epicRepository));
        _featureRepository = featureRepository ?? throw new ArgumentNullException(nameof(featureRepository));
    }

    /// <summary>
    /// Get backlog (Epics, Features, User Stories) for a repository
    /// </summary>
    /// <param name="repositoryId">The ID of the repository</param>
    [HttpGet("repository/{repositoryId}")]
    public async Task<IActionResult> GetBacklog(Guid repositoryId, CancellationToken cancellationToken)
    {
        var query = new GetBacklogByRepositoryIdQuery(repositoryId);
        var epics = await _mediator.Send(query, cancellationToken);

        return Ok(epics);
    }

    /// <summary>
    /// Create backlog from AI-generated data
    /// </summary>
    /// <param name="repositoryId">The ID of the repository</param>
    /// <param name="request">The generated backlog data</param>
    [HttpPost("repository/{repositoryId}")]
    public async Task<IActionResult> CreateBacklog(
        Guid repositoryId, 
        [FromBody] CreateBacklogRequest request, 
        CancellationToken cancellationToken)
    {
        _logger.LogInformation("Creating backlog for repository {RepositoryId} with {EpicCount} epics", 
            repositoryId, request.Epics?.Count ?? 0);

        var command = new CreateBacklogCommand(repositoryId, request);
        var epics = await _mediator.Send(command, cancellationToken);

        return Ok(epics);
    }

    /// <summary>
    /// Update a user story's status (e.g., after PR is created)
    /// </summary>
    /// <param name="storyId">The ID of the user story</param>
    /// <param name="request">The new status and optional PR URL</param>
    [HttpPatch("story/{storyId}/status")]
    public async Task<IActionResult> UpdateStoryStatus(
        Guid storyId,
        [FromBody] UpdateStoryStatusRequest request,
        CancellationToken cancellationToken)
    {
        _logger.LogInformation("Updating status for story {StoryId} to {Status}, PR URL: {PrUrl}", 
            storyId, request.Status, request.PrUrl ?? "none");

        var command = new UpdateStoryStatusCommand(storyId, request.Status, request.PrUrl);
        var success = await _mediator.Send(command, cancellationToken);

        if (!success)
        {
            return NotFound(new { error = "User story not found" });
        }

        return Ok(new { success = true, storyId, status = request.Status, prUrl = request.PrUrl });
    }

    /// <summary>
    /// Add a new Epic to a repository
    /// </summary>
    [HttpPost("repository/{repositoryId}/epic")]
    public async Task<IActionResult> AddEpic(
        Guid repositoryId,
        [FromBody] AddEpicRequest request,
        CancellationToken cancellationToken)
    {
        var command = new AddEpicCommand(repositoryId, request.Title, request.Description);
        var epic = await _mediator.Send(command, cancellationToken);
        return Ok(epic);
    }

    /// <summary>
    /// Add a new Feature to an Epic
    /// </summary>
    [HttpPost("epic/{epicId}/feature")]
    public async Task<IActionResult> AddFeature(
        Guid epicId,
        [FromBody] AddFeatureRequest request,
        CancellationToken cancellationToken)
    {
        var command = new AddFeatureCommand(epicId, request.Title, request.Description);
        var feature = await _mediator.Send(command, cancellationToken);
        return Ok(feature);
    }

    /// <summary>
    /// Add a new User Story to a Feature
    /// </summary>
    [HttpPost("feature/{featureId}/story")]
    public async Task<IActionResult> AddUserStory(
        Guid featureId,
        [FromBody] AddUserStoryRequest request,
        CancellationToken cancellationToken)
    {
        var command = new AddUserStoryCommand(
            featureId,
            request.Title,
            request.Description,
            request.AcceptanceCriteria,
            request.StoryPoints);
        var story = await _mediator.Send(command, cancellationToken);
        return Ok(story);
    }

    /// <summary>
    /// Delete an Epic (cascades to Features and User Stories)
    /// </summary>
    [HttpDelete("epic/{epicId}")]
    public async Task<IActionResult> DeleteEpic(Guid epicId, CancellationToken cancellationToken)
    {
        var command = new DeleteEpicCommand(epicId);
        var success = await _mediator.Send(command, cancellationToken);
        if (!success) return NotFound(new { error = "Epic not found" });
        return Ok(new { success = true });
    }

    /// <summary>
    /// Delete a Feature (cascades to User Stories)
    /// </summary>
    [HttpDelete("feature/{featureId}")]
    public async Task<IActionResult> DeleteFeature(Guid featureId, CancellationToken cancellationToken)
    {
        var command = new DeleteFeatureCommand(featureId);
        var success = await _mediator.Send(command, cancellationToken);
        if (!success) return NotFound(new { error = "Feature not found" });
        return Ok(new { success = true });
    }

    /// <summary>
    /// Delete a User Story
    /// </summary>
    [HttpDelete("story/{storyId}")]
    public async Task<IActionResult> DeleteUserStory(Guid storyId, CancellationToken cancellationToken)
    {
        var command = new DeleteUserStoryCommand(storyId);
        var success = await _mediator.Send(command, cancellationToken);
        if (!success) return NotFound(new { error = "User story not found" });
        return Ok(new { success = true });
    }

    /// <summary>
    /// Update an Epic
    /// </summary>
    [HttpPut("epic/{epicId}")]
    public async Task<IActionResult> UpdateEpic(
        Guid epicId,
        [FromBody] UpdateEpicRequest request,
        CancellationToken cancellationToken)
    {
        var epic = await _epicRepository.GetByIdAsync(epicId, cancellationToken);
        if (epic == null) return NotFound(new { error = "Epic not found" });

        epic.UpdateTitle(request.Title);
        epic.UpdateDescription(request.Description);
        if (!string.IsNullOrEmpty(request.Status))
        {
            epic.ChangeStatus(request.Status);
        }

        await _epicRepository.UpdateAsync(epic, cancellationToken);

        return Ok(new
        {
            id = epic.Id,
            title = epic.Title,
            description = epic.Description,
            status = epic.Status
        });
    }

    /// <summary>
    /// Update a Feature
    /// </summary>
    [HttpPut("feature/{featureId}")]
    public async Task<IActionResult> UpdateFeature(
        Guid featureId,
        [FromBody] UpdateFeatureRequest request,
        CancellationToken cancellationToken)
    {
        var feature = await _featureRepository.GetByIdAsync(featureId, cancellationToken);
        if (feature == null) return NotFound(new { error = "Feature not found" });

        feature.UpdateTitle(request.Title);
        feature.UpdateDescription(request.Description);
        if (!string.IsNullOrEmpty(request.Status))
        {
            feature.ChangeStatus(request.Status);
        }

        await _featureRepository.UpdateAsync(feature, cancellationToken);

        return Ok(new
        {
            id = feature.Id,
            title = feature.Title,
            description = feature.Description,
            status = feature.Status,
            epicId = feature.EpicId
        });
    }

    /// <summary>
    /// Update a User Story
    /// </summary>
    [HttpPut("story/{storyId}")]
    public async Task<IActionResult> UpdateUserStory(
        Guid storyId,
        [FromBody] UpdateUserStoryRequest request,
        CancellationToken cancellationToken)
    {
        var story = await _userStoryRepository.GetByIdAsync(storyId, cancellationToken);
        if (story == null) return NotFound(new { error = "User story not found" });

        story.UpdateTitle(request.Title);
        story.UpdateDescription(request.Description);
        story.UpdateAcceptanceCriteria(request.AcceptanceCriteria);
        story.SetStoryPoints(request.StoryPoints);
        if (!string.IsNullOrEmpty(request.Status))
        {
            story.ChangeStatus(request.Status);
        }

        await _userStoryRepository.UpdateAsync(story, cancellationToken);

        return Ok(new
        {
            id = story.Id,
            title = story.Title,
            description = story.Description,
            status = story.Status,
            acceptanceCriteria = story.AcceptanceCriteria,
            storyPoints = story.StoryPoints,
            featureId = story.FeatureId
        });
    }

    /// <summary>
    /// Sync PR statuses for all stories with PRs in a repository
    /// Checks GitHub for PR status and updates story status accordingly:
    /// - PR open -> PendingReview
    /// - PR merged -> Done
    /// </summary>
    /// <param name="repositoryId">The ID of the repository</param>
    /// <param name="request">Contains the GitHub access token</param>
    [HttpPost("repository/{repositoryId}/sync-pr-status")]
    public async Task<IActionResult> SyncPrStatuses(
        Guid repositoryId,
        [FromBody] SyncPrStatusRequest request,
        CancellationToken cancellationToken)
    {
        _logger.LogInformation("Syncing PR statuses for repository {RepositoryId}", repositoryId);

        // Get all stories for this repository
        var query = new GetBacklogByRepositoryIdQuery(repositoryId);
        var epics = await _mediator.Send(query, cancellationToken);

        var updatedStories = new List<object>();

        foreach (var epic in epics)
        {
            foreach (var feature in epic.Features)
            {
                foreach (var story in feature.UserStories)
                {
                    // Skip stories without PR URLs
                    if (string.IsNullOrEmpty(story.PrUrl))
                        continue;

                    // Skip stories already marked as Done
                    if (story.Status.Equals("Done", StringComparison.OrdinalIgnoreCase))
                        continue;

                    try
                    {
                        // Get PR status from GitHub
                        var prStatus = await _gitHubService.GetPullRequestStatusAsync(
                            request.AccessToken,
                            story.PrUrl,
                            cancellationToken);

                        string newStatus;
                        if (prStatus.IsMerged)
                        {
                            newStatus = "Done";
                        }
                        else if (prStatus.State == "closed")
                        {
                            // PR closed without merge - keep as PendingReview or set to specific status
                            newStatus = "PendingReview";
                        }
                        else
                        {
                            // PR still open
                            newStatus = "PendingReview";
                        }

                        // Only update if status changed
                        if (!story.Status.Equals(newStatus, StringComparison.OrdinalIgnoreCase))
                        {
                            var command = new UpdateStoryStatusCommand(story.Id, newStatus, story.PrUrl);
                            await _mediator.Send(command, cancellationToken);

                            updatedStories.Add(new
                            {
                                storyId = story.Id,
                                storyTitle = story.Title,
                                oldStatus = story.Status,
                                newStatus,
                                prMerged = prStatus.IsMerged,
                                prState = prStatus.State
                            });

                            _logger.LogInformation(
                                "Updated story {StoryId} from {OldStatus} to {NewStatus} (PR merged: {IsMerged})",
                                story.Id, story.Status, newStatus, prStatus.IsMerged);
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Failed to check PR status for story {StoryId} with URL {PrUrl}",
                            story.Id, story.PrUrl);
                    }
                }
            }
        }

        return Ok(new
        {
            success = true,
            repositoryId,
            updatedCount = updatedStories.Count,
            updatedStories
        });
    }

    /// <summary>
    /// Check PR status for a single story
    /// </summary>
    [HttpGet("story/{storyId}/pr-status")]
    public async Task<IActionResult> CheckStoryPrStatus(
        Guid storyId,
        [FromQuery] string accessToken,
        CancellationToken cancellationToken)
    {
        var story = await _userStoryRepository.GetByIdAsync(storyId, cancellationToken);
        if (story == null)
        {
            return NotFound(new { error = "Story not found" });
        }

        if (string.IsNullOrEmpty(story.PrUrl))
        {
            return Ok(new { storyId, hasPr = false });
        }

        try
        {
            var prStatus = await _gitHubService.GetPullRequestStatusAsync(
                accessToken,
                story.PrUrl,
                cancellationToken);

            // Determine the expected status based on PR state
            string expectedStatus;
            if (prStatus.IsMerged)
            {
                expectedStatus = "Done";
            }
            else
            {
                expectedStatus = "PendingReview";
            }

            // Update if needed
            bool statusUpdated = false;
            if (!story.Status.Equals(expectedStatus, StringComparison.OrdinalIgnoreCase))
            {
                story.ChangeStatus(expectedStatus);
                await _userStoryRepository.UpdateAsync(story, cancellationToken);
                statusUpdated = true;
            }

            return Ok(new
            {
                storyId,
                hasPr = true,
                prUrl = story.PrUrl,
                prState = prStatus.State,
                prMerged = prStatus.IsMerged,
                prMergedAt = prStatus.MergedAt,
                storyStatus = expectedStatus,
                statusUpdated
            });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to check PR status for story {StoryId}", storyId);
            return Ok(new
            {
                storyId,
                hasPr = true,
                prUrl = story.PrUrl,
                error = ex.Message
            });
        }
    }
}

/// <summary>
/// Request model for updating story status
/// </summary>
public class UpdateStoryStatusRequest
{
    public string Status { get; set; } = string.Empty;
    public string? PrUrl { get; set; }
}

/// <summary>
/// Request model for syncing PR statuses
/// </summary>
public class SyncPrStatusRequest
{
    public string AccessToken { get; set; } = string.Empty;
}

/// <summary>
/// Request model for adding an Epic
/// </summary>
public class AddEpicRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
}

/// <summary>
/// Request model for adding a Feature
/// </summary>
public class AddFeatureRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
}

/// <summary>
/// Request model for adding a User Story
/// </summary>
public class AddUserStoryRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? AcceptanceCriteria { get; set; }
    public int? StoryPoints { get; set; }
}

/// <summary>
/// Request model for updating an Epic
/// </summary>
public class UpdateEpicRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Status { get; set; }
}

/// <summary>
/// Request model for updating a Feature
/// </summary>
public class UpdateFeatureRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Status { get; set; }
}

/// <summary>
/// Request model for updating a User Story
/// </summary>
public class UpdateUserStoryRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? AcceptanceCriteria { get; set; }
    public int? StoryPoints { get; set; }
    public string? Status { get; set; }
}
