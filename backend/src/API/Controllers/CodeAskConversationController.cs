namespace DevPilot.API.Controllers;

using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Serialization;
using DevPilot.Domain.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Persists Code Ask chat history per user, repository, and branch (PostgreSQL).
/// </summary>
[ApiController]
[Route("api/repositories/{repositoryId:guid}/code-ask")]
[Authorize]
public class CodeAskConversationController : ControllerBase
{
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly ICodeAskConversationRepository _codeAskConversationRepository;
    private readonly ILogger<CodeAskConversationController> _logger;

    public CodeAskConversationController(
        IRepositoryRepository repositoryRepository,
        ICodeAskConversationRepository codeAskConversationRepository,
        ILogger<CodeAskConversationController> logger)
    {
        _repositoryRepository = repositoryRepository;
        _codeAskConversationRepository = codeAskConversationRepository;
        _logger = logger;
    }

    /// <summary>Load saved Ask messages for this repo and branch.</summary>
    [HttpGet]
    public async Task<IActionResult> Get(Guid repositoryId, [FromQuery] string? branch, CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
            return Unauthorized();

        var repo = await _repositoryRepository.GetByIdIfAccessibleAsync(repositoryId, userId, cancellationToken);
        if (repo is null)
            return NotFound();

        var key = NormalizeBranchKey(branch);
        var row = await _codeAskConversationRepository.GetAsync(userId, repositoryId, key, cancellationToken);
        if (row is null)
            return Ok(new CodeAskConversationResponse { Messages = [] });

        try
        {
            var messages = JsonSerializer.Deserialize<List<CodeAskMessageDto>>(row.PayloadJson, JsonOptions())
                           ?? [];
            return Ok(new CodeAskConversationResponse { Messages = messages });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Invalid code-ask payload for repository {RepositoryId}", repositoryId);
            return Ok(new CodeAskConversationResponse { Messages = [] });
        }
    }

    /// <summary>Replace saved Ask messages for this repo and branch.</summary>
    [HttpPut]
    public async Task<IActionResult> Put(Guid repositoryId, [FromBody] PutCodeAskConversationRequest? body, CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
            return Unauthorized();

        var repo = await _repositoryRepository.GetByIdIfAccessibleAsync(repositoryId, userId, cancellationToken);
        if (repo is null)
            return NotFound();

        if (body?.Messages is null)
            return BadRequest(new { error = "messages is required" });

        var key = NormalizeBranchKey(body.RepoBranch);
        var json = JsonSerializer.Serialize(body.Messages, JsonOptions());

        await _codeAskConversationRepository.UpsertAsync(userId, repositoryId, key, json, cancellationToken);
        return Ok(new { saved = true });
    }

    private static JsonSerializerOptions JsonOptions() => new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true
    };

    private static string NormalizeBranchKey(string? branch)
    {
        var s = string.IsNullOrWhiteSpace(branch) ? "main" : branch.Trim();
        return s.ToLowerInvariant();
    }

    private Guid GetUserId()
    {
        var raw = User.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(raw, out var id) ? id : Guid.Empty;
    }
}

public class CodeAskConversationResponse
{
    [JsonPropertyName("messages")]
    public List<CodeAskMessageDto> Messages { get; set; } = [];
}

public class PutCodeAskConversationRequest
{
    [JsonPropertyName("repo_branch")]
    public string? RepoBranch { get; set; }

    [JsonPropertyName("messages")]
    public List<CodeAskMessageDto>? Messages { get; set; }
}

public class CodeAskMessageDto
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("role")]
    public string Role { get; set; } = "";

    [JsonPropertyName("content")]
    public string Content { get; set; } = "";

    [JsonPropertyName("toolCallsSummary")]
    public string? ToolCallsSummary { get; set; }
}
