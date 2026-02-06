namespace DevPilot.API.Controllers;

using DevPilot.Application.Queries;
using DevPilot.Application.UseCases;
using DevPilot.Application.Services;
using DevPilot.Domain.Interfaces;
using DevPilot.Domain.Entities;
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Authorization;
using System.Security.Claims;
using OpenAI;
using OpenAI.Chat;

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
    private readonly ILinkedProviderRepository _linkedProviderRepository;
    private readonly IUserRepository _userRepository;
    private readonly IConfiguration _configuration;

    public BacklogController(
        IMediator mediator, 
        ILogger<BacklogController> logger,
        IGitHubService gitHubService,
        IUserStoryRepository userStoryRepository,
        IEpicRepository epicRepository,
        IFeatureRepository featureRepository,
        ILinkedProviderRepository linkedProviderRepository,
        IUserRepository userRepository,
        IConfiguration configuration)
    {
        _mediator = mediator ?? throw new ArgumentNullException(nameof(mediator));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _gitHubService = gitHubService ?? throw new ArgumentNullException(nameof(gitHubService));
        _userStoryRepository = userStoryRepository ?? throw new ArgumentNullException(nameof(userStoryRepository));
        _epicRepository = epicRepository ?? throw new ArgumentNullException(nameof(epicRepository));
        _featureRepository = featureRepository ?? throw new ArgumentNullException(nameof(featureRepository));
        _linkedProviderRepository = linkedProviderRepository ?? throw new ArgumentNullException(nameof(linkedProviderRepository));
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
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
        var command = new AddEpicCommand(repositoryId, request.Title, request.Description, request.Source, request.AzureDevOpsWorkItemId);
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
        var command = new AddFeatureCommand(epicId, request.Title, request.Description, request.Source, request.AzureDevOpsWorkItemId);
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
            request.StoryPoints,
            request.Source,
            request.AzureDevOpsWorkItemId);
        var story = await _mediator.Send(command, cancellationToken);
        return Ok(story);
    }

    /// <summary>
    /// Sync backlog items imported from Azure DevOps back to Azure DevOps
    /// Updates title, description, status, story points, acceptance criteria
    /// When epicIds, featureIds, storyIds are provided, only those items are synced.
    /// </summary>
    [HttpPost("repository/{repositoryId}/sync-to-azure-devops")]
    [Authorize]
    public async Task<IActionResult> SyncToAzureDevOps(Guid repositoryId, [FromBody] SyncToAzureDevOpsRequest? request, CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var epicIds = request?.EpicIds ?? Array.Empty<Guid>();
        var featureIds = request?.FeatureIds ?? Array.Empty<Guid>();
        var storyIds = request?.StoryIds ?? Array.Empty<Guid>();

        var command = new SyncBacklogToAzureDevOpsCommand(repositoryId, userId, epicIds, featureIds, storyIds);
        var result = await _mediator.Send(command, cancellationToken);

        if (!result.Success && result.SyncedCount == 0 && result.FailedCount == 0)
        {
            return BadRequest(new { success = false, message = result.Errors.FirstOrDefault(), errors = result.Errors });
        }

        return Ok(new
        {
            success = result.Success,
            syncedCount = result.SyncedCount,
            failedCount = result.FailedCount,
            errors = result.Errors
        });
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
    /// Uses the authenticated user's GitHub token from the database.
    /// </summary>
    /// <param name="repositoryId">The ID of the repository</param>
    [HttpPost("repository/{repositoryId}/sync-pr-status")]
    [Authorize]
    public async Task<IActionResult> SyncPrStatuses(
        Guid repositoryId,
        CancellationToken cancellationToken)
    {
        _logger.LogInformation("Syncing PR statuses for repository {RepositoryId}", repositoryId);

        // Get user ID from JWT token
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized(new { error = "Invalid user token" });
        }

        // Get GitHub access token from database
        var accessToken = await GetGitHubAccessTokenAsync(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { error = "GitHub is not connected. Please link your GitHub account first." });
        }

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
                            accessToken,
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

    /// <summary>
    /// Get the head (source) branch name of a pull request from its URL.

    /// Used when opening a story that already has a PR so the sandbox can clone that branch.
    /// Uses the authenticated user's GitHub token from the database.
    /// </summary>
    [HttpPost("pr-head-branch")]
    [Authorize]
    public async Task<IActionResult> GetPrHeadBranch(
        [FromBody] PrHeadBranchRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.PrUrl))
        {
            return BadRequest(new { error = "prUrl is required" });
        }

        // Get user ID from JWT token
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized(new { error = "Invalid user token" });
        }

        // Get GitHub access token from database
        var accessToken = await GetGitHubAccessTokenAsync(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { error = "GitHub is not connected. Please link your GitHub account first." });
        }

        try
        {
            var branch = await _gitHubService.GetPullRequestHeadBranchAsync(
                accessToken,
                request.PrUrl,
                cancellationToken);

            if (string.IsNullOrEmpty(branch))
            {
                return NotFound(new { error = "Could not get PR head branch", prUrl = request.PrUrl });
            }

            return Ok(new { branch });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to get PR head branch for {PrUrl}", request.PrUrl);
            return BadRequest(new { error = ex.Message });
        }
    }

    /// <summary>
    /// Use AI to suggest improved description or acceptance criteria for a backlog item
    /// </summary>
    [HttpPost("ai/suggest")]
    [Authorize]
    public async Task<IActionResult> AISuggest(
        [FromBody] AISuggestRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
        {
            return BadRequest(new { error = "Title is required for AI suggestion." });
        }

        if (request.Field != "description" && request.Field != "acceptanceCriteria")
        {
            return BadRequest(new { error = "Field must be 'description' or 'acceptanceCriteria'." });
        }

        // Get user ID from JWT token
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized(new { error = "Invalid user token" });
        }

        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        if (user == null)
        {
            return Unauthorized(new { error = "User not found" });
        }

        // Get user's AI settings with fallback to global config
        var apiKey = user.AiApiKey ?? _configuration["AI:ApiKey"];
        var endpoint = user.AiBaseUrl ?? _configuration["AI:Endpoint"];
        var model = user.AiModel ?? _configuration["AI:Model"] ?? "gpt-4o-mini";

        if (string.IsNullOrEmpty(apiKey))
        {
            return BadRequest(new { error = "AI API key not configured. Please configure your AI settings first." });
        }

        try
        {
            // Build the prompt
            var systemPrompt = BuildAISuggestSystemPrompt(request.Field, request.ItemType);
            var userPrompt = BuildAISuggestUserPrompt(request.Field, request.ItemType, request.Title, request.CurrentContent, request.Description);

            // Create OpenAI client
            ChatClient client;
            if (!string.IsNullOrEmpty(endpoint))
            {
                var clientOptions = new OpenAIClientOptions
                {
                    Endpoint = new Uri(endpoint)
                };
                client = new ChatClient(
                    model: model,
                    credential: new System.ClientModel.ApiKeyCredential(apiKey),
                    options: clientOptions
                );
            }
            else
            {
                client = new ChatClient(model, apiKey);
            }

            var chatOptions = new ChatCompletionOptions
            {
                Temperature = 0.7f
            };

            var messages = new List<ChatMessage>
            {
                new SystemChatMessage(systemPrompt),
                new UserChatMessage(userPrompt)
            };

            _logger.LogInformation("AI suggest request: field={Field}, itemType={ItemType}, title={Title}",
                request.Field, request.ItemType, request.Title);

            var response = await client.CompleteChatAsync(messages, chatOptions, cancellationToken);
            var suggestion = response.Value.Content[0].Text.Trim();

            return Ok(new { suggestion });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "AI suggestion failed for field={Field}, itemType={ItemType}", request.Field, request.ItemType);
            return StatusCode(500, new { error = "AI suggestion failed. Please try again." });
        }
    }

    private static string BuildAISuggestSystemPrompt(string field, string itemType)
    {
        var typeLabel = itemType switch
        {
            "epic" => "Epic",
            "feature" => "Feature",
            "story" => "User Story",
            _ => "backlog item"
        };

        if (field == "acceptanceCriteria")
        {
            return $@"You are an experienced product owner and agile coach. Your task is to write or improve acceptance criteria for a {typeLabel}.

Rules:
- Always write in English.
- Use the Given/When/Then (Gherkin) format for every criterion:
  ""- Given [precondition], When [action], Then [expected result]""
- Each criterion must be specific, measurable, and independently testable.
- Cover the main happy path, key edge cases, and at least one error scenario.
- Keep each criterion concise (1-3 lines max).
- Write one criterion per bullet point, starting with ""- Given"".
- Output ONLY the acceptance criteria text, no headers, no explanations, no markdown code blocks.";
        }

        return $@"You are an experienced product owner and agile coach. Your task is to write or improve the description for a {typeLabel}.

Rules:
- Always write in English.
- Write a clear, concise description that explains the purpose and scope.
- For user stories, use the format: ""As a [persona], I want [action] so that [benefit]"" when appropriate.
- For epics and features, describe the business value and high-level scope.
- Keep it under 3-4 sentences unless the topic warrants more detail.
- Output ONLY the description text, no headers, no explanations, no markdown code blocks.";
    }

    private static string BuildAISuggestUserPrompt(string field, string itemType, string title, string? currentContent, string? description)
    {
        var typeLabel = itemType switch
        {
            "epic" => "Epic",
            "feature" => "Feature",
            "story" => "User Story",
            _ => "backlog item"
        };

        var prompt = $"{typeLabel} title: \"{title}\"";

        if (field == "acceptanceCriteria")
        {
            if (!string.IsNullOrWhiteSpace(description))
            {
                prompt += $"\nDescription: \"{description}\"";
            }
            if (!string.IsNullOrWhiteSpace(currentContent))
            {
                prompt += $"\n\nExisting acceptance criteria to improve:\n{currentContent}";
            }
            else
            {
                prompt += "\n\nWrite acceptance criteria for this item.";
            }
        }
        else
        {
            if (!string.IsNullOrWhiteSpace(currentContent))
            {
                prompt += $"\n\nExisting description to improve:\n{currentContent}";
            }
            else
            {
                prompt += "\n\nWrite a description for this item.";
            }
        }

        return prompt;
    }

    /// <summary>
    /// Get GitHub access token from linked providers or legacy user field
    /// </summary>
    private async Task<string?> GetGitHubAccessTokenAsync(Guid userId, CancellationToken cancellationToken)
    {
        // First try linked providers (new approach)
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
        if (!string.IsNullOrEmpty(linkedProvider?.AccessToken))
        {
            return linkedProvider.AccessToken;
        }

        // Fallback to legacy GitHubAccessToken field on User
        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        return user?.GitHubAccessToken;
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

public class SyncToAzureDevOpsRequest
{
    public Guid[] EpicIds { get; set; } = Array.Empty<Guid>();
    public Guid[] FeatureIds { get; set; } = Array.Empty<Guid>();
    public Guid[] StoryIds { get; set; } = Array.Empty<Guid>();
}

/// <summary>
/// Request model for getting PR head branch (for cloning when continuing a story with existing PR)
/// </summary>
public class PrHeadBranchRequest
{
    public string PrUrl { get; set; } = string.Empty;
    public string AccessToken { get; set; } = string.Empty;
}

/// <summary>
/// Request model for adding an Epic
/// </summary>
public class AddEpicRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Source { get; set; } // "Manual", "AzureDevOps", "GitHub"
    public int? AzureDevOpsWorkItemId { get; set; }
}

/// <summary>
/// Request model for adding a Feature
/// </summary>
public class AddFeatureRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Source { get; set; }
    public int? AzureDevOpsWorkItemId { get; set; }
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
    public string? Source { get; set; }
    public int? AzureDevOpsWorkItemId { get; set; }
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

/// <summary>
/// Request model for AI-powered field suggestion
/// </summary>
public class AISuggestRequest
{
    public string Field { get; set; } = string.Empty; // "description" or "acceptanceCriteria"
    public string ItemType { get; set; } = string.Empty; // "epic", "feature", "story"
    public string Title { get; set; } = string.Empty;
    public string? CurrentContent { get; set; }
    public string? Description { get; set; } // For AC suggestions, the story description for context
}
