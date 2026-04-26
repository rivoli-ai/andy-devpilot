namespace DevPilot.API.Controllers;

using System.Security.Claims;
using Azure.Core;
using Azure.Identity;
using DevPilot.Application.Commands;
using DevPilot.Application.Options;
using DevPilot.Application.Queries;
using DevPilot.Application.Services;
using DevPilot.Application.UseCases;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;

/// <summary>
/// Request body for adding a GitHub repo manually
/// </summary>
public class AddManualGitHubRepoRequest
{
    public required string RepoUrl { get; set; }
}

public class CreateUnpublishedRepositoryRequest
{
    public required string Name { get; set; }
    public string? Description { get; set; }
}

public class PublishUnpublishedToGitHubRequest
{
    public required string RepositoryName { get; set; }
    public string? Description { get; set; }
    public bool IsPrivate { get; set; }
    /// <summary>If set, create under this GitHub org; if null, create under the user account.</summary>
    public string? OrganizationLogin { get; set; }
}

public class PublishUnpublishedToAzureRequest
{
    public required string Organization { get; set; }
    public required string Project { get; set; }
    public required string RepositoryName { get; set; }
    public string? Readme { get; set; }
}

/// <summary>Write or update a text file in a local (unpublished) project workspace.</summary>
public class UnpublishedWriteFileRequest
{
    public required string Path { get; set; }
    public required string Content { get; set; }
}

/// <summary>
/// Request body for creating a pull request
/// </summary>
public class CreatePullRequestRequest
{
    public required string HeadBranch { get; set; }
    public required string BaseBranch { get; set; }
    public required string Title { get; set; }
    public string? Body { get; set; }
    /// <summary>Azure DevOps work item IDs to link to the PR (e.g. [190])</summary>
    public List<int>? WorkItemIds { get; set; }
}

/// <summary>
/// Request body for syncing selected repositories from a provider
/// </summary>
public class SyncSelectedRepositoriesRequest
{
    /// <summary>Repository full names to add (e.g. "owner/repo" for GitHub, "org/project/repo" for Azure DevOps)</summary>
    public List<string> FullNames { get; set; } = new();
}

/// <summary>
/// Request body for syncing selected Azure DevOps repositories
/// </summary>
public class SyncSelectedAzureRepositoriesRequest
{
    public required string Organization { get; set; }
    /// <summary>Repository full names to add (e.g. "org/project/repo")</summary>
    public List<string> FullNames { get; set; } = new();
}

/// <summary>
/// Request body for sharing a repository with another user (by email)
/// </summary>
public class ShareRepositoryRequest
{
    public required string Email { get; set; }
}

public class UpdateRepositoryLlmSettingRequest
{
    public Guid? LlmSettingId { get; set; }
}

public class UpdateRepositoryAgentRulesRequest
{
    public string? AgentRules { get; set; }
}

public class RepositoryAgentRuleItemRequest
{
    public Guid? Id { get; set; }
    public string Name { get; set; } = "";
    public string Body { get; set; } = "";
    public bool IsDefault { get; set; }
    public int SortOrder { get; set; }
}

public class ReplaceRepositoryAgentRulesRequest
{
    public List<RepositoryAgentRuleItemRequest> Rules { get; set; } = new();
}

public class UpdateAzureIdentityRequest
{
    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }
    public string? TenantId { get; set; }
}

/// <summary>
/// Optional fields merge with stored values: empty client secret uses the secret saved for this repo (if any).
/// </summary>
public class VerifyAzureIdentityRequest
{
    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }
    public string? TenantId { get; set; }
}

/// <summary>
/// Controller for managing repositories
/// Follows Clean Architecture - no business logic, only delegates to Application layer
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class RepositoriesController : ControllerBase
{
    private readonly IMediator _mediator;
    private readonly IUserRepository _userRepository;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IRepositoryShareRepository _repositoryShareRepository;
    private readonly ILinkedProviderRepository _linkedProviderRepository;
    private readonly ILlmSettingRepository _llmSettingRepository;
    private readonly IGitHubService _gitHubService;
    private readonly IAzureDevOpsService _azureDevOpsService;
    private readonly IRepositoryAgentRuleRepository _repositoryAgentRuleRepository;
    private readonly IUnpublishedRepositoryFileStore _unpublishedFileStore;
    private readonly IConfiguration _configuration;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly IOptions<UnpublishedRepositoryOptions> _unpublishedOptions;
    private readonly ILogger<RepositoriesController> _logger;

    public RepositoriesController(
        IMediator mediator,
        IUserRepository userRepository,
        IRepositoryRepository repositoryRepository,
        IRepositoryShareRepository repositoryShareRepository,
        ILinkedProviderRepository linkedProviderRepository,
        ILlmSettingRepository llmSettingRepository,
        IGitHubService gitHubService,
        IAzureDevOpsService azureDevOpsService,
        IRepositoryAgentRuleRepository repositoryAgentRuleRepository,
        IUnpublishedRepositoryFileStore unpublishedFileStore,
        IConfiguration configuration,
        IHttpContextAccessor httpContextAccessor,
        IOptions<UnpublishedRepositoryOptions> unpublishedOptions,
        ILogger<RepositoriesController> logger)
    {
        _mediator = mediator ?? throw new ArgumentNullException(nameof(mediator));
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _repositoryShareRepository = repositoryShareRepository ?? throw new ArgumentNullException(nameof(repositoryShareRepository));
        _linkedProviderRepository = linkedProviderRepository ?? throw new ArgumentNullException(nameof(linkedProviderRepository));
        _llmSettingRepository = llmSettingRepository ?? throw new ArgumentNullException(nameof(llmSettingRepository));
        _gitHubService = gitHubService ?? throw new ArgumentNullException(nameof(gitHubService));
        _azureDevOpsService = azureDevOpsService ?? throw new ArgumentNullException(nameof(azureDevOpsService));
        _repositoryAgentRuleRepository = repositoryAgentRuleRepository ?? throw new ArgumentNullException(nameof(repositoryAgentRuleRepository));
        _unpublishedFileStore = unpublishedFileStore ?? throw new ArgumentNullException(nameof(unpublishedFileStore));
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
        _httpContextAccessor = httpContextAccessor ?? throw new ArgumentNullException(nameof(httpContextAccessor));
        _unpublishedOptions = unpublishedOptions ?? throw new ArgumentNullException(nameof(unpublishedOptions));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Get repositories for the current authenticated user.
    /// Supports pagination and search via query params.
    /// </summary>
    /// <param name="search">Optional search term (matches repository name, full name, or organization)</param>
    /// <param name="filter">Optional visibility: "all" | "mine" | "shared"</param>
    /// <param name="page">Page number (1-based)</param>
    /// <param name="pageSize">Items per page (1-100)</param>
    [HttpGet]
    [Authorize]
    public async Task<IActionResult> GetRepositories(
        [FromQuery] string? search = null,
        [FromQuery] string? filter = null,
        [FromQuery] int? page = null,
        [FromQuery] int? pageSize = null,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        if (page.HasValue || pageSize.HasValue || !string.IsNullOrWhiteSpace(search))
        {
            var paginatedQuery = new GetRepositoriesPaginatedQuery(
                userId,
                search,
                filter,
                page ?? 1,
                pageSize ?? 20);
            var result = await _mediator.Send(paginatedQuery, cancellationToken);
            return Ok(result);
        }

        var query = new GetRepositoriesByUserIdQuery(userId, filter);
        var repositories = await _mediator.Send(query, cancellationToken);
        return Ok(repositories);
    }

    /// <summary>
    /// Delete a repository and its backlog (epics, features, stories). Analysis data is cascade-deleted.
    /// </summary>
    [HttpDelete("{id}")]
    [Authorize]
    public async Task<IActionResult> DeleteRepository(Guid id, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var repo = await _repositoryRepository.GetByIdAsync(id, cancellationToken);
        if (repo == null)
        {
            return NotFound(new { message = "Repository not found" });
        }
        if (repo.UserId != userId)
        {
            return Forbid();
        }

        var deleted = await _repositoryRepository.DeleteAsync(id, cancellationToken);
        if (!deleted)
        {
            return NotFound(new { message = "Repository not found" });
        }

        _logger.LogInformation("User {UserId} deleted repository {RepositoryId} ({FullName})", userId, id, repo.FullName);
        return Ok(new { message = "Repository deleted" });
    }

    /// <summary>
    /// Update repository's LLM setting (owner or user with access). Set to null to use user default.
    /// </summary>
    [HttpPatch("{id}/llm-setting")]
    [Authorize]
    public async Task<IActionResult> UpdateRepositoryLlmSetting(Guid id, [FromBody] UpdateRepositoryLlmSettingRequest request, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");

        if (await _repositoryRepository.GetByIdIfAccessibleAsync(id, userId, cancellationToken) is null)
            return Forbid();
        var repo = await _repositoryRepository.GetByIdTrackedAsync(id, cancellationToken);
        if (repo == null) return NotFound(new { message = "Repository not found" });

        if (request.LlmSettingId.HasValue)
        {
            var llm = await _llmSettingRepository.GetByIdAsync(request.LlmSettingId.Value, cancellationToken);
            if (llm == null || llm.UserId != userId)
                return BadRequest(new { message = "LLM setting not found or not yours" });
        }

        _logger.LogInformation("[PATCH llm-setting] Repo {RepoId}: old LlmSettingId={Old}, new LlmSettingId={New}",
            id, repo.LlmSettingId?.ToString() ?? "(null)", request.LlmSettingId?.ToString() ?? "(null)");
        repo.SetLlmSetting(request.LlmSettingId);
        await _repositoryRepository.UpdateAsync(repo, cancellationToken);

        // Verify the save by re-reading from DB (untracked)
        var verify = await _repositoryRepository.GetByIdAsync(id, cancellationToken);
        _logger.LogInformation("[PATCH llm-setting] Verify after save: Repo {RepoId} LlmSettingId={Saved}",
            id, verify?.LlmSettingId?.ToString() ?? "(null)");

        return Ok(new { message = "Repository LLM setting updated", llmSettingId = request.LlmSettingId });
    }

    /// <summary>
    /// Update repository's legacy single-field agent rules (owner or user with access). Prefer named rules via PUT agent-rules.
    /// </summary>
    [HttpPatch("{id}/agent-rules")]
    [Authorize]
    public async Task<IActionResult> UpdateRepositoryAgentRules(Guid id, [FromBody] UpdateRepositoryAgentRulesRequest request, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");

        if (await _repositoryRepository.GetByIdIfAccessibleAsync(id, userId, cancellationToken) is null)
            return Forbid();
        var repo = await _repositoryRepository.GetByIdTrackedAsync(id, cancellationToken);
        if (repo == null) return NotFound(new { message = "Repository not found" });

        repo.UpdateAgentRules(request.AgentRules);
        await _repositoryRepository.UpdateAsync(repo, cancellationToken);

        return Ok(new { message = "Repository agent rules updated", agentRules = repo.AgentRules });
    }

    /// <summary>
    /// Get repository's AI agent rules: named profiles plus optional legacy single-field text.
    /// </summary>
    [HttpGet("{id}/agent-rules")]
    [Authorize]
    public async Task<IActionResult> GetRepositoryAgentRules(Guid id, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");

        var repo = await _repositoryRepository.GetByIdIfAccessibleAsync(id, userId, cancellationToken);
        if (repo == null) return NotFound(new { message = "Repository not found" });

        var rules = await _repositoryAgentRuleRepository.GetByRepositoryIdAsync(id, cancellationToken);
        return Ok(new
        {
            rules = rules.Select(r => new
            {
                id = r.Id,
                name = r.Name,
                body = r.Body,
                isDefault = r.IsDefault,
                sortOrder = r.SortOrder
            }),
            legacyAgentRules = repo.AgentRules,
            // No implicit product template: empty rules means "not configured", not "built-in default".
            isDefault = false
        });
    }

    /// <summary>
    /// Replace all named agent rules for a repository (owner or user with access). At most one rule should have isDefault true.
    /// </summary>
    [HttpPut("{id}/agent-rules")]
    [Authorize]
    public async Task<IActionResult> ReplaceRepositoryAgentRules(
        Guid id,
        [FromBody] ReplaceRepositoryAgentRulesRequest? request,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");

        if (await _repositoryRepository.GetByIdIfAccessibleAsync(id, userId, cancellationToken) is null)
            return Forbid();
        var repo = await _repositoryRepository.GetByIdTrackedAsync(id, cancellationToken);
        if (repo == null) return NotFound(new { message = "Repository not found" });

        if (request?.Rules == null)
            return BadRequest(new { message = "rules array is required." });

        foreach (var r in request.Rules)
        {
            if (string.IsNullOrWhiteSpace(r.Name))
                return BadRequest(new { message = "Each rule must have a non-empty name." });
        }

        var normalized = request.Rules.Select((r, i) =>
                (Id: r.Id, Name: r.Name.Trim(), Body: r.Body ?? "", IsDefault: r.IsDefault, SortOrder: r.SortOrder != 0 ? r.SortOrder : i))
            .ToList();

        var defaultCount = normalized.Count(x => x.IsDefault);
        if (defaultCount > 1)
        {
            var firstDef = normalized.FindIndex(x => x.IsDefault);
            normalized = normalized.Select((x, idx) => (x.Id, x.Name, x.Body, IsDefault: idx == firstDef, x.SortOrder)).ToList();
        }
        else if (defaultCount == 0 && normalized.Count > 0)
        {
            normalized = normalized.Select((x, idx) => (x.Id, x.Name, x.Body, IsDefault: idx == 0, x.SortOrder)).ToList();
        }

        await _repositoryAgentRuleRepository.ReplaceForRepositoryAsync(
            id,
            normalized.Select(x => (x.Id, x.Name, x.Body, x.IsDefault, x.SortOrder)).ToList(),
            cancellationToken);

        var rules = await _repositoryAgentRuleRepository.GetByRepositoryIdAsync(id, cancellationToken);
        return Ok(new
        {
            message = "Repository agent rules updated",
            rules = rules.Select(r => new { id = r.Id, name = r.Name, body = r.Body, isDefault = r.IsDefault, sortOrder = r.SortOrder })
        });
    }

    /// <summary>
    /// Update Azure Service Principal identity for sandbox authentication (owner or user with access).
    /// Pass all three fields to set, or all null/empty to clear.
    /// </summary>
    [HttpPatch("{id}/azure-identity")]
    [Authorize]
    public async Task<IActionResult> UpdateAzureIdentity(Guid id, [FromBody] UpdateAzureIdentityRequest request, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");

        if (await _repositoryRepository.GetByIdIfAccessibleAsync(id, userId, cancellationToken) is null)
            return Forbid();
        var repo = await _repositoryRepository.GetByIdTrackedAsync(id, cancellationToken);
        if (repo == null) return NotFound(new { message = "Repository not found" });

        var hasAny = !string.IsNullOrWhiteSpace(request.ClientId) || !string.IsNullOrWhiteSpace(request.ClientSecret) || !string.IsNullOrWhiteSpace(request.TenantId);
        var hasAll = !string.IsNullOrWhiteSpace(request.ClientId) && !string.IsNullOrWhiteSpace(request.ClientSecret) && !string.IsNullOrWhiteSpace(request.TenantId);

        if (hasAny && !hasAll)
            return BadRequest(new { message = "All three fields (clientId, clientSecret, tenantId) must be provided together, or all left empty to clear." });

        repo.UpdateAzureIdentity(
            hasAll ? request.ClientId!.Trim() : null,
            hasAll ? request.ClientSecret!.Trim() : null,
            hasAll ? request.TenantId!.Trim() : null);

        await _repositoryRepository.UpdateAsync(repo, cancellationToken);

        return Ok(new { message = "Azure identity updated", hasAzureIdentity = hasAll });
    }

    /// <summary>
    /// Get Azure Service Principal identity config (owner or user with access; never returns the secret).
    /// </summary>
    [HttpGet("{id}/azure-identity")]
    [Authorize]
    public async Task<IActionResult> GetAzureIdentity(Guid id, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");

        var repo = await _repositoryRepository.GetByIdIfAccessibleAsync(id, userId, cancellationToken);
        if (repo == null) return NotFound(new { message = "Repository not found" });

        return Ok(new
        {
            clientId = repo.AzureIdentityClientId,
            tenantId = repo.AzureIdentityTenantId,
            hasSecret = !string.IsNullOrEmpty(repo.AzureIdentityClientSecret),
            hasAzureIdentity = !string.IsNullOrEmpty(repo.AzureIdentityClientId)
                && !string.IsNullOrEmpty(repo.AzureIdentityClientSecret)
                && !string.IsNullOrEmpty(repo.AzureIdentityTenantId)
        });
    }

    /// <summary>
    /// Verify Azure Service Principal credentials by acquiring an access token (owner or user with access).
    /// Request body may omit fields that are already stored; empty clientSecret reuses the stored secret.
    /// </summary>
    [HttpPost("{id:guid}/azure-identity/verify")]
    [Authorize]
    public async Task<IActionResult> VerifyAzureIdentity(Guid id, [FromBody] VerifyAzureIdentityRequest request, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");

        if (await _repositoryRepository.GetByIdIfAccessibleAsync(id, userId, cancellationToken) is null)
            return Forbid();
        var repo = await _repositoryRepository.GetByIdTrackedAsync(id, cancellationToken);
        if (repo == null) return NotFound(new { message = "Repository not found" });

        var clientId = !string.IsNullOrWhiteSpace(request.ClientId) ? request.ClientId.Trim() : repo.AzureIdentityClientId;
        var tenantId = !string.IsNullOrWhiteSpace(request.TenantId) ? request.TenantId.Trim() : repo.AzureIdentityTenantId;
        var clientSecret = !string.IsNullOrWhiteSpace(request.ClientSecret)
            ? request.ClientSecret.Trim()
            : repo.AzureIdentityClientSecret;

        if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(tenantId) || string.IsNullOrWhiteSpace(clientSecret))
        {
            return BadRequest(new
            {
                message = "Tenant ID, Client ID, and Client Secret are required to test. Enter a new secret or save credentials first.",
                ok = false
            });
        }

        // Azure Resource Manager scope — validates client credentials for typical automation / Key Vault scenarios
        const string scope = "https://management.azure.com/.default";
        try
        {
            var credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
            var token = await credential.GetTokenAsync(new TokenRequestContext([scope]), cancellationToken);
            return Ok(new
            {
                ok = true,
                message = "Successfully authenticated with Microsoft Entra ID. Credentials are valid for the sandbox.",
                expiresOn = token.ExpiresOn
            });
        }
        catch (AuthenticationFailedException ex)
        {
            _logger.LogWarning(ex, "Azure identity verification failed for repository {RepoId}", id);
            return BadRequest(new
            {
                ok = false,
                message = "Azure AD rejected these credentials. Check the Client ID, secret, and Tenant ID, and that the app registration allows client-secret flow.",
                detail = ex.Message
            });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Azure identity verification error for repository {RepoId}", id);
            return BadRequest(new
            {
                ok = false,
                message = "Could not verify credentials with Azure.",
                detail = ex.Message
            });
        }
    }

    /// <summary>
    /// List users this repository is shared with (owner only).
    /// </summary>
    [HttpGet("{id}/shared-with")]
    [Authorize]
    public async Task<IActionResult> GetSharedWith(Guid id, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");

        var repo = await _repositoryRepository.GetByIdAsync(id, cancellationToken);
        if (repo == null) return NotFound(new { message = "Repository not found" });
        if (repo.UserId != userId) return Forbid();

        var sharedWithIds = await _repositoryShareRepository.GetSharedWithUserIdsAsync(id, cancellationToken);
        var users = new List<object>();
        foreach (var uid in sharedWithIds)
        {
            var u = await _userRepository.GetByIdAsync(uid, cancellationToken);
            if (u != null)
                users.Add(new { userId = u.Id, email = u.Email, name = u.Name });
        }
        return Ok(new { sharedWith = users });
    }

    /// <summary>
    /// Share this repository with another user by email (owner only).
    /// </summary>
    [HttpPost("{id}/share")]
    [Authorize]
    public async Task<IActionResult> ShareRepository(Guid id, [FromBody] ShareRepositoryRequest request, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");

        if (string.IsNullOrWhiteSpace(request?.Email))
            return BadRequest(new { message = "Email is required" });

        var repo = await _repositoryRepository.GetByIdAsync(id, cancellationToken);
        if (repo == null) return NotFound(new { message = "Repository not found" });
        if (repo.UserId != userId) return Forbid();

        var targetUser = await _userRepository.GetByEmailAsync(request.Email.Trim(), cancellationToken);
        if (targetUser == null)
            return NotFound(new { message = "No user found with this email address" });
        if (targetUser.Id == userId)
            return BadRequest(new { message = "You cannot share a repository with yourself" });

        if (await _repositoryShareRepository.ExistsAsync(id, targetUser.Id, cancellationToken))
            return Ok(new { message = "Repository is already shared with this user" });

        await _repositoryShareRepository.AddAsync(new RepositoryShare(id, targetUser.Id), cancellationToken);
        _logger.LogInformation("User {UserId} shared repository {RepositoryId} with {TargetEmail}", userId, id, targetUser.Email);
        return Ok(new { message = "Repository shared", sharedWithUserId = targetUser.Id });
    }

    /// <summary>
    /// Remove access for a user (owner only).
    /// </summary>
    [HttpDelete("{id}/share/{sharedWithUserId:guid}")]
    [Authorize]
    public async Task<IActionResult> UnshareRepository(Guid id, Guid sharedWithUserId, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");

        var repo = await _repositoryRepository.GetByIdAsync(id, cancellationToken);
        if (repo == null) return NotFound(new { message = "Repository not found" });
        if (repo.UserId != userId) return Forbid();

        var removed = await _repositoryShareRepository.RemoveAsync(id, sharedWithUserId, cancellationToken);
        if (!removed) return NotFound(new { message = "Share not found" });
        _logger.LogInformation("User {UserId} unshared repository {RepositoryId} from user {SharedWithUserId}", userId, id, sharedWithUserId);
        return Ok(new { message = "Access removed" });
    }

    /// <summary>
    /// Sync repositories from GitHub for the current authenticated user
    /// Fetches repositories from GitHub and stores them in the database
    /// Uses linked provider access token (with fallback to legacy field)
    /// </summary>
    [HttpPost("sync/github")]
    [Authorize]
    public async Task<IActionResult> SyncRepositoriesFromGitHub(CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        // Try to get GitHub access token from linked providers first
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
        string? accessToken = linkedProvider?.AccessToken;

        // Fallback to legacy field if not found in linked providers
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            if (user == null)
            {
                return Unauthorized("User not found");
            }
            accessToken = user.GitHubAccessToken;
        }

        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return BadRequest(new { message = "GitHub is not connected. Please link your GitHub account first.", provider = "GitHub" });
        }

        var command = new SyncRepositoriesFromGitHubCommand(userId, accessToken);
        var repositories = await _mediator.Send(command, cancellationToken);

        return Ok(repositories);
    }

    /// <summary>
    /// Get list of repositories available from GitHub (not yet in app). Used for selective sync.
    /// </summary>
    [HttpGet("available/github")]
    [Authorize]
    public async Task<IActionResult> GetAvailableGitHubRepositories(CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
        string? accessToken = linkedProvider?.AccessToken;
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            accessToken = user?.GitHubAccessToken;
        }
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return BadRequest(new { message = "GitHub is not connected. Please link your GitHub account first.", provider = "GitHub" });
        }

        var gitHubRepos = await _gitHubService.GetRepositoriesAsync(accessToken, cancellationToken);
        var existingRepos = await _repositoryRepository.GetByUserIdAsync(userId, cancellationToken);
        var existingSet = new HashSet<string>(existingRepos.Where(r => r.Provider == "GitHub").Select(r => r.FullName), StringComparer.OrdinalIgnoreCase);

        var list = gitHubRepos.Select(r => new
        {
            fullName = r.FullName,
            name = r.Name,
            description = r.Description,
            isPrivate = r.IsPrivate,
            defaultBranch = r.DefaultBranch ?? "main",
            alreadyInApp = existingSet.Contains(r.FullName)
        }).ToList();

        return Ok(list);
    }

    /// <summary>
    /// Sync only selected GitHub repositories into the app.
    /// </summary>
    [HttpPost("sync/github/selected")]
    [Authorize]
    public async Task<IActionResult> SyncSelectedGitHubRepositories([FromBody] SyncSelectedRepositoriesRequest request, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        if (request?.FullNames == null || request.FullNames.Count == 0)
        {
            return Ok(new { added = 0, repositories = Array.Empty<object>() });
        }

        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
        string? accessToken = linkedProvider?.AccessToken;
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            accessToken = user?.GitHubAccessToken;
        }
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return BadRequest(new { message = "GitHub is not connected. Please link your GitHub account first.", provider = "GitHub" });
        }

        var added = new List<object>();
        foreach (var fullName in request.FullNames.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (string.IsNullOrWhiteSpace(fullName)) continue;
            var parts = fullName.Trim().Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2) continue;

            var existing = await _repositoryRepository.GetByFullNameProviderAndUserIdAsync(fullName.Trim(), "GitHub", userId, cancellationToken);
            if (existing != null) continue;

            var gitHubRepo = await _gitHubService.GetRepositoryAsync(accessToken, parts[0], parts[1], cancellationToken);
            if (gitHubRepo == null) continue;

            var newRepo = new Repository(
                name: gitHubRepo.Name,
                fullName: gitHubRepo.FullName,
                cloneUrl: gitHubRepo.CloneUrl,
                provider: "GitHub",
                organizationName: gitHubRepo.OrganizationName,
                userId: userId,
                description: gitHubRepo.Description,
                isPrivate: gitHubRepo.IsPrivate,
                defaultBranch: gitHubRepo.DefaultBranch ?? "main");
            await _repositoryRepository.AddAsync(newRepo, cancellationToken);
            added.Add(new
            {
                id = newRepo.Id,
                name = newRepo.Name,
                fullName = newRepo.FullName,
                provider = newRepo.Provider,
                organizationName = newRepo.OrganizationName,
                defaultBranch = newRepo.DefaultBranch
            });
        }

        _logger.LogInformation("User {UserId} synced {Count} selected repositories from GitHub", userId, added.Count);
        return Ok(new { added = added.Count, repositories = added });
    }

    /// <summary>
    /// Add a GitHub repository manually by URL (e.g. https://github.com/owner/repo or owner/repo).
    /// Public repos can be added without connecting GitHub; private repos require a linked GitHub account.
    /// </summary>
    [HttpPost("add-github")]
    [Authorize]
    public async Task<IActionResult> AddManualGitHubRepository([FromBody] AddManualGitHubRepoRequest request, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        if (string.IsNullOrWhiteSpace(request?.RepoUrl))
        {
            return BadRequest(new { message = "Repository URL or owner/repo is required" });
        }

        var (owner, repo) = ParseGitHubRepoUrl(request.RepoUrl.Trim());
        if (owner == null || repo == null)
        {
            return BadRequest(new { message = "Invalid GitHub URL. Use https://github.com/owner/repo or owner/repo" });
        }

        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
        var accessToken = linkedProvider?.AccessToken;
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            accessToken = user?.GitHubAccessToken;
        }

        GitHubRepositoryDto? gitHubRepo;
        if (!string.IsNullOrWhiteSpace(accessToken))
        {
            gitHubRepo = await _gitHubService.GetRepositoryAsync(accessToken, owner, repo, cancellationToken);
            if (gitHubRepo == null)
            {
                return NotFound(new { message = $"Repository {owner}/{repo} not found or you don't have access to it" });
            }
        }
        else
        {
            // No GitHub connected: allow adding public repos only via unauthenticated API
            gitHubRepo = await _gitHubService.GetRepositoryPublicAsync(owner, repo, cancellationToken);
            if (gitHubRepo == null)
            {
                return BadRequest(new { message = "Repository not found or is private. Public repos can be added without connecting GitHub; connect GitHub to add private repos." });
            }
        }

        var existingRepo = await _repositoryRepository.GetByFullNameProviderAndUserIdAsync(gitHubRepo.FullName, "GitHub", userId, cancellationToken);
        if (existingRepo != null)
        {
            return Ok(new
            {
                id = existingRepo.Id,
                name = existingRepo.Name,
                fullName = existingRepo.FullName,
                provider = existingRepo.Provider,
                organizationName = existingRepo.OrganizationName,
                defaultBranch = existingRepo.DefaultBranch,
                alreadyExists = true
            });
        }

        var newRepo = new Repository(
            name: gitHubRepo.Name,
            fullName: gitHubRepo.FullName,
            cloneUrl: gitHubRepo.CloneUrl,
            provider: "GitHub",
            organizationName: gitHubRepo.OrganizationName,
            userId: userId,
            description: gitHubRepo.Description,
            isPrivate: gitHubRepo.IsPrivate,
            defaultBranch: gitHubRepo.DefaultBranch ?? "main");
        await _repositoryRepository.AddAsync(newRepo, cancellationToken);

        _logger.LogInformation("User {UserId} manually added GitHub repository {FullName}", userId, newRepo.FullName);

        return Ok(new
        {
            id = newRepo.Id,
            name = newRepo.Name,
            fullName = newRepo.FullName,
            provider = newRepo.Provider,
            organizationName = newRepo.OrganizationName,
            defaultBranch = newRepo.DefaultBranch,
            alreadyExists = false
        });
    }

    /// <summary>
    /// Create a local-only (unpublished) repository with starter backlog. Publish later to GitHub or Azure DevOps.
    /// </summary>
    [HttpPost("unpublished")]
    [Authorize]
    public async Task<IActionResult> CreateUnpublishedRepository(
        [FromBody] CreateUnpublishedRepositoryRequest? request,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");
        if (string.IsNullOrWhiteSpace(request?.Name))
            return BadRequest(new { message = "Name is required" });

        try
        {
            var dto = await _mediator.Send(
                new CreateUnpublishedRepositoryCommand(userId, request.Name.Trim(), request.Description?.Trim()),
                cancellationToken);
            return Ok(dto);
        }
        catch (ArgumentException ex)
        {
            return BadRequest(new { message = ex.Message });
        }
    }

    /// <summary>
    /// Create a GitHub repository and point this DevPilot project at it (unpublished → GitHub).
    /// </summary>
    [HttpPost("{id:guid}/publish/github")]
    [Authorize]
    public async Task<IActionResult> PublishUnpublishedToGitHub(
        Guid id,
        [FromBody] PublishUnpublishedToGitHubRequest? request,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");
        if (string.IsNullOrWhiteSpace(request?.RepositoryName))
            return BadRequest(new { message = "RepositoryName is required" });

        try
        {
            var dto = await _mediator.Send(
                new PublishUnpublishedToGitHubCommand(
                    userId,
                    id,
                    request.RepositoryName.Trim(),
                    request.Description?.Trim(),
                    request.IsPrivate,
                    request.OrganizationLogin?.Trim()),
                cancellationToken);
            return Ok(dto);
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { message = ex.Message });
        }
        catch (ArgumentException ex)
        {
            return BadRequest(new { message = ex.Message });
        }
    }

    /// <summary>
    /// Create an Azure DevOps Git repo in a project and point this DevPilot project at it (unpublished → Azure).
    /// </summary>
    [HttpPost("{id:guid}/publish/azure-devops")]
    [Authorize]
    public async Task<IActionResult> PublishUnpublishedToAzureDevOps(
        Guid id,
        [FromBody] PublishUnpublishedToAzureRequest? request,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized("User ID not found in token");
        if (string.IsNullOrWhiteSpace(request?.Organization)
            || string.IsNullOrWhiteSpace(request?.Project)
            || string.IsNullOrWhiteSpace(request?.RepositoryName))
        {
            return BadRequest(new { message = "Organization, Project, and RepositoryName are required" });
        }

        try
        {
            var dto = await _mediator.Send(
                new PublishUnpublishedToAzureCommand(
                    userId,
                    id,
                    request.Organization.Trim(),
                    request.Project.Trim(),
                    request.RepositoryName.Trim(),
                    request.Readme),
                cancellationToken);
            return Ok(dto);
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { message = ex.Message });
        }
        catch (ArgumentException ex)
        {
            return BadRequest(new { message = ex.Message });
        }
    }

    private static (string? owner, string? repo) ParseGitHubRepoUrl(string input)
    {
        input = input.Trim();
        if (string.IsNullOrEmpty(input)) return (null, null);

        if (input.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase))
        {
            var path = input["https://github.com/".Length..].TrimEnd('/');
            var parts = path.Split('/');
            if (parts.Length >= 2) return (parts[0], parts[1].Replace(".git", ""));
        }
        else if (input.StartsWith("http://github.com/", StringComparison.OrdinalIgnoreCase))
        {
            var path = input["http://github.com/".Length..].TrimEnd('/');
            var parts = path.Split('/');
            if (parts.Length >= 2) return (parts[0], parts[1].Replace(".git", ""));
        }
        else if (input.StartsWith("git@github.com:", StringComparison.OrdinalIgnoreCase))
        {
            var path = input["git@github.com:".Length..].Replace(".git", "");
            var parts = path.Split('/');
            if (parts.Length >= 2) return (parts[0], parts[1]);
            if (parts.Length == 1) return (parts[0].Split(':')[0], parts[0].Split(':').LastOrDefault());
        }
        else if (input.Contains('/'))
        {
            var parts = input.Split('/');
            if (parts.Length >= 2) return (parts[0], parts[1].Replace(".git", ""));
        }

        return (null, null);
    }

    /// <summary>
    /// Sync repositories from Azure DevOps for the current authenticated user
    /// Fetches repositories from Azure DevOps and stores them in the database
    /// </summary>
    [HttpPost("sync/azure-devops")]
    [Authorize]
    public async Task<IActionResult> SyncRepositoriesFromAzureDevOps([FromBody] AzureDevOpsSyncRequest? request, CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        // Get user for potential token storage
        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        if (user == null)
        {
            return Unauthorized("User not found");
        }

        // Get Azure DevOps access token from linked providers
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.AzureDevOps, cancellationToken);
        
        // PRIORITY: 1. User's stored PAT from Settings, 2. Request PAT, 3. OAuth token
        bool hasStoredPat = !string.IsNullOrWhiteSpace(user.AzureDevOpsAccessToken);
        bool hasRequestPat = !string.IsNullOrWhiteSpace(request?.PersonalAccessToken);
        bool hasOAuthToken = linkedProvider != null && !string.IsNullOrWhiteSpace(linkedProvider.AccessToken);
        
        if (!hasStoredPat && !hasRequestPat && !hasOAuthToken)
        {
            return BadRequest(new { message = "Azure DevOps is not connected. Please configure your PAT in Settings or link your Azure DevOps account.", provider = "AzureDevOps" });
        }

        try
        {
            _logger.LogInformation("Starting Azure DevOps repository sync for user {UserId}", userId);
            
            // Determine which token to use: Stored PAT > Request PAT > OAuth token
            string accessToken;
            bool usingPat = false;
            
            if (hasStoredPat)
            {
                // Use stored PAT from Settings - convert to Basic auth format
                accessToken = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
                usingPat = true;
                _logger.LogInformation("Using stored PAT from Settings for Azure DevOps authentication");
            }
            else if (hasRequestPat)
            {
                // Use PAT from request - convert to Basic auth format for Azure DevOps
                accessToken = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes($":{request!.PersonalAccessToken}"));
                usingPat = true;
                _logger.LogInformation("Using Personal Access Token from request for Azure DevOps authentication");
                
                // Store PAT for later use (code browsing, pull requests, etc.)
                user.UpdateAzureDevOpsToken(request.PersonalAccessToken);
                await _userRepository.UpdateAsync(user, cancellationToken);
                _logger.LogInformation("Stored Azure DevOps PAT for user {UserId}", userId);
            }
            else if (hasOAuthToken)
            {
                accessToken = linkedProvider!.AccessToken;
                _logger.LogInformation("Using OAuth token for Azure DevOps authentication");
            }
            else
            {
                return BadRequest(new { message = "No authentication available. Please configure your PAT in Settings or link your Azure DevOps account." });
            }
            
            List<Application.Services.AzureDevOpsRepositoryDto> reposList;
            
            // Use organization from: 1. Request, 2. User's stored settings
            var organizationName = !string.IsNullOrWhiteSpace(request?.OrganizationName) 
                ? request.OrganizationName 
                : user.AzureDevOpsOrganization;
            
            // If organization name is available, fetch directly from that organization
            if (!string.IsNullOrWhiteSpace(organizationName))
            {
                _logger.LogInformation("Fetching repositories from organization: {Organization}", organizationName);
                var allRepos = new List<Application.Services.AzureDevOpsRepositoryDto>();
                
                // Get all projects in the organization using the appropriate token
                var projects = await _azureDevOpsService.GetProjectsAsync(accessToken, organizationName, cancellationToken, usingPat);
                _logger.LogInformation("Found {Count} projects in organization {Organization}", projects.Count(), organizationName);
                
                foreach (var project in projects)
                {
                    var projectRepos = await _azureDevOpsService.GetProjectRepositoriesAsync(
                        accessToken,
                        organizationName,
                        project.Name,
                        cancellationToken,
                        usingPat);
                    allRepos.AddRange(projectRepos);
                }
                
                reposList = allRepos;
            }
            else
            {
                // Try automatic organization discovery (may not work with Entra ID tokens)
                var azureDevOpsRepos = await _azureDevOpsService.GetRepositoriesAsync(accessToken, cancellationToken);
                reposList = azureDevOpsRepos.ToList();
            }
            
            _logger.LogInformation("Found {Count} repositories from Azure DevOps", reposList.Count);
            
            if (reposList.Count == 0)
            {
                _logger.LogWarning("No repositories found in Azure DevOps");
                return Ok(new { 
                    message = "No repositories found. Try specifying your organization name (e.g., 'myorg' from dev.azure.com/myorg).",
                    requiresOrganization = true,
                    repositories = new List<object>()
                });
            }
            
            // Convert to our repository format and save
            var savedRepos = new List<object>();
            foreach (var adoRepo in reposList)
            {
                // Check if repository already exists for THIS USER
                var existingRepo = await _repositoryRepository.GetByFullNameProviderAndUserIdAsync(
                    $"{adoRepo.OrganizationName}/{adoRepo.ProjectName}/{adoRepo.Name}", 
                    "AzureDevOps",
                    userId,
                    cancellationToken);

                if (existingRepo == null)
                {
                    var newRepo = new Repository(
                        name: adoRepo.Name,
                        fullName: $"{adoRepo.OrganizationName}/{adoRepo.ProjectName}/{adoRepo.Name}",
                        cloneUrl: adoRepo.RemoteUrl,
                        provider: "AzureDevOps",
                        organizationName: adoRepo.OrganizationName,
                        userId: userId,
                        description: null,
                        isPrivate: true, // Azure DevOps repos are typically private
                        defaultBranch: adoRepo.DefaultBranch ?? "main"
                    );
                    await _repositoryRepository.AddAsync(newRepo, cancellationToken);
                    savedRepos.Add(new
                    {
                        id = newRepo.Id,
                        name = newRepo.Name,
                        fullName = newRepo.FullName,
                        provider = newRepo.Provider,
                        organizationName = newRepo.OrganizationName,
                        defaultBranch = newRepo.DefaultBranch
                    });
                }
                else
                {
                    savedRepos.Add(new
                    {
                        id = existingRepo.Id,
                        name = existingRepo.Name,
                        fullName = existingRepo.FullName,
                        provider = existingRepo.Provider,
                        organizationName = existingRepo.OrganizationName,
                        defaultBranch = existingRepo.DefaultBranch
                    });
                }
            }

            return Ok(savedRepos);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to sync repositories from Azure DevOps for user {UserId}", userId);
            return BadRequest(new { message = $"Failed to sync from Azure DevOps: {ex.Message}" });
        }
    }

    /// <summary>
    /// Get list of repositories available from Azure DevOps (optionally filtered by organization). Used for selective sync.
    /// </summary>
    [HttpGet("available/azure-devops")]
    [Authorize]
    public async Task<IActionResult> GetAvailableAzureDevOpsRepositories([FromQuery] string? organization, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        if (user == null) return Unauthorized("User not found");

        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.AzureDevOps, cancellationToken);
        bool hasStoredPat = !string.IsNullOrWhiteSpace(user.AzureDevOpsAccessToken);
        bool hasOAuthToken = linkedProvider != null && !string.IsNullOrWhiteSpace(linkedProvider.AccessToken);
        if (!hasStoredPat && !hasOAuthToken)
        {
            return BadRequest(new { message = "Azure DevOps is not connected. Configure PAT in Settings or link your account.", provider = "AzureDevOps" });
        }

        string accessToken = hasStoredPat
            ? Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"))
            : linkedProvider!.AccessToken;
        bool usingPat = hasStoredPat;

        List<Application.Services.AzureDevOpsRepositoryDto> reposList;
        var organizationName = !string.IsNullOrWhiteSpace(organization) ? organization : user.AzureDevOpsOrganization;
        if (!string.IsNullOrWhiteSpace(organizationName))
        {
            var allRepos = new List<Application.Services.AzureDevOpsRepositoryDto>();
            var projects = await _azureDevOpsService.GetProjectsAsync(accessToken, organizationName, cancellationToken, usingPat);
            foreach (var project in projects)
            {
                var projectRepos = await _azureDevOpsService.GetProjectRepositoriesAsync(accessToken, organizationName, project.Name, cancellationToken, usingPat);
                allRepos.AddRange(projectRepos);
            }
            reposList = allRepos;
        }
        else
        {
            reposList = (await _azureDevOpsService.GetRepositoriesAsync(accessToken, cancellationToken)).ToList();
        }

        var existingRepos = await _repositoryRepository.GetByUserIdAsync(userId, cancellationToken);
        var existingSet = new HashSet<string>(existingRepos.Where(r => r.Provider == "AzureDevOps").Select(r => r.FullName), StringComparer.OrdinalIgnoreCase);

        var list = reposList.Select(r =>
        {
            var fullName = $"{r.OrganizationName}/{r.ProjectName}/{r.Name}";
            return new
            {
                fullName,
                name = r.Name,
                projectName = r.ProjectName,
                organizationName = r.OrganizationName,
                defaultBranch = r.DefaultBranch ?? "main",
                alreadyInApp = existingSet.Contains(fullName)
            };
        }).ToList();

        return Ok(list);
    }

    /// <summary>
    /// Sync only selected Azure DevOps repositories into the app.
    /// </summary>
    [HttpPost("sync/azure-devops/selected")]
    [Authorize]
    public async Task<IActionResult> SyncSelectedAzureDevOpsRepositories([FromBody] SyncSelectedAzureRepositoriesRequest request, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        if (request?.FullNames == null || request.FullNames.Count == 0)
        {
            return Ok(new { added = 0, repositories = Array.Empty<object>() });
        }

        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        if (user == null) return Unauthorized("User not found");

        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.AzureDevOps, cancellationToken);
        bool hasStoredPat = !string.IsNullOrWhiteSpace(user.AzureDevOpsAccessToken);
        bool hasOAuthToken = linkedProvider != null && !string.IsNullOrWhiteSpace(linkedProvider.AccessToken);
        if (!hasStoredPat && !hasOAuthToken)
        {
            return BadRequest(new { message = "Azure DevOps is not connected. Configure PAT in Settings or link your account.", provider = "AzureDevOps" });
        }

        string accessToken = hasStoredPat
            ? Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"))
            : linkedProvider!.AccessToken;
        bool usingPat = hasStoredPat;

        var organizationName = request.Organization?.Trim();
        if (string.IsNullOrWhiteSpace(organizationName))
        {
            return BadRequest(new { message = "Organization is required for Azure DevOps sync." });
        }

        var allRepos = new List<Application.Services.AzureDevOpsRepositoryDto>();
        var projects = await _azureDevOpsService.GetProjectsAsync(accessToken, organizationName, cancellationToken, usingPat);
        foreach (var project in projects)
        {
            var projectRepos = await _azureDevOpsService.GetProjectRepositoriesAsync(accessToken, organizationName, project.Name, cancellationToken, usingPat);
            allRepos.AddRange(projectRepos);
        }

        var fullNameToAdo = allRepos.ToDictionary(r => $"{r.OrganizationName}/{r.ProjectName}/{r.Name}", StringComparer.OrdinalIgnoreCase);
        var added = new List<object>();
        foreach (var fullName in request.FullNames.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (string.IsNullOrWhiteSpace(fullName)) continue;
            var key = fullName.Trim();
            if (!fullNameToAdo.TryGetValue(key, out var adoRepo)) continue;

            var existing = await _repositoryRepository.GetByFullNameProviderAndUserIdAsync(key, "AzureDevOps", userId, cancellationToken);
            if (existing != null) continue;

            var newRepo = new Repository(
                name: adoRepo.Name,
                fullName: key,
                cloneUrl: adoRepo.RemoteUrl,
                provider: "AzureDevOps",
                organizationName: adoRepo.OrganizationName,
                userId: userId,
                description: null,
                isPrivate: true,
                defaultBranch: adoRepo.DefaultBranch ?? "main");
            await _repositoryRepository.AddAsync(newRepo, cancellationToken);
            added.Add(new
            {
                id = newRepo.Id,
                name = newRepo.Name,
                fullName = newRepo.FullName,
                provider = newRepo.Provider,
                organizationName = newRepo.OrganizationName,
                defaultBranch = newRepo.DefaultBranch
            });
        }

        _logger.LogInformation("User {UserId} synced {Count} selected repositories from Azure DevOps", userId, added.Count);
        return Ok(new { added = added.Count, repositories = added });
    }

    /// <summary>
    /// Get available sync sources for the current user
    /// Returns which providers (GitHub, Azure DevOps) are linked
    /// </summary>
    [HttpGet("sync/sources")]
    [Authorize]
    public async Task<IActionResult> GetAvailableSyncSources(CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var linkedProviders = await _linkedProviderRepository.GetByUserIdAsync(userId, cancellationToken);
        
        // Also check legacy/stored credentials (PAT in Settings)
        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        var hasLegacyGitHub = !string.IsNullOrWhiteSpace(user?.GitHubAccessToken);
        var hasStoredAzurePat = !string.IsNullOrWhiteSpace(user?.AzureDevOpsAccessToken);

        var sources = new List<object>();

        // Check GitHub
        var hasGitHub = linkedProviders.Any(p => p.Provider == ProviderTypes.GitHub) || hasLegacyGitHub;
        if (hasGitHub)
        {
            var githubProvider = linkedProviders.FirstOrDefault(p => p.Provider == ProviderTypes.GitHub);
            sources.Add(new
            {
                provider = "GitHub",
                isLinked = true,
                username = githubProvider?.ProviderUsername ?? user?.GitHubUsername
            });
        }
        else
        {
            sources.Add(new { provider = "GitHub", isLinked = false, username = (string?)null });
        }

        // Check Azure DevOps (OAuth link OR stored PAT in Settings)
        var azureDevOpsProvider = linkedProviders.FirstOrDefault(p => p.Provider == ProviderTypes.AzureDevOps);
        var hasAzureDevOps = azureDevOpsProvider != null || hasStoredAzurePat;
        if (hasAzureDevOps)
        {
            sources.Add(new
            {
                provider = "AzureDevOps",
                isLinked = true,
                username = azureDevOpsProvider?.ProviderUsername ?? user?.AzureDevOpsOrganization ?? "PAT"
            });
        }
        else
        {
            sources.Add(new { provider = "AzureDevOps", isLinked = false, username = (string?)null });
        }

        return Ok(sources);
    }

    /// <summary>
    /// Get Azure DevOps projects for the configured organization
    /// </summary>
    [HttpGet("azure-devops/projects")]
    [Authorize]
    public async Task<IActionResult> GetAzureDevOpsProjects(CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        try
        {
            // Get user to access stored settings
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            
            if (user == null || string.IsNullOrEmpty(user.AzureDevOpsOrganization))
            {
                return BadRequest(new { message = "Azure DevOps organization is not configured. Please set it in Settings." });
            }

            string accessToken;
            bool useBasicAuth = false;

            // Use stored PAT if available
            if (!string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
            {
                var credentials = Convert.ToBase64String(
                    System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
                accessToken = credentials;
                useBasicAuth = true;
                _logger.LogInformation("Using stored PAT for fetching Azure DevOps projects");
            }
            else
            {
                // Fall back to OAuth token
                var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(
                    userId, ProviderTypes.AzureDevOps, cancellationToken);

                if (linkedProvider == null)
                {
                    return BadRequest(new { 
                        message = "Azure DevOps is not configured. Please add your PAT in Settings.",
                        requiresPat = true 
                    });
                }

                accessToken = linkedProvider.AccessToken;
            }

            var projects = await _azureDevOpsService.GetProjectsAsync(
                accessToken, 
                user.AzureDevOpsOrganization, 
                cancellationToken, 
                useBasicAuth);

            return Ok(projects);
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "Azure DevOps authentication failed for projects");
            return BadRequest(new { message = ex.Message });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching Azure DevOps projects");
            return StatusCode(500, new { message = "Failed to fetch projects" });
        }
    }

    /// <summary>
    /// Request body for fetching Azure DevOps work items
    /// </summary>
    public class AzureDevOpsWorkItemsRequest
    {
        public string? OrganizationName { get; set; }
        public required string ProjectName { get; set; }
        public string? TeamId { get; set; }
        public string? PersonalAccessToken { get; set; }
        /// <summary>Classification area node id; preferred over <see cref="AreaPath"/> (filters with <c>System.AreaId</c> to avoid WIT path validation errors).</summary>
        public int? AreaNodeId { get; set; }
        /// <summary>When set, WIQL is scoped to this <c>System.AreaPath</c> (and sub-areas when <see cref="IncludeDescendantAreaPaths"/> is not false). Ignored when <see cref="AreaNodeId"/> is set.</summary>
        public string? AreaPath { get; set; }
        /// <summary>When a team is selected: if true (default), include work items in all child area paths under each team area (WIQL "UNDER"). If false, match Azure &quot;include children&quot; per path (sub-areas may be excluded). Same for an explicit <see cref="AreaPath"/> or <see cref="AreaNodeId"/> subtree.</summary>
        public bool? IncludeDescendantAreaPaths { get; set; }
    }

    /// <summary>
    /// Get Azure DevOps teams for a project
    /// </summary>
    [HttpGet("azure-devops/projects/{projectName}/teams")]
    [Authorize]
    public async Task<IActionResult> GetAzureDevOpsTeams(string projectName, CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        try
        {
            // Get user to access stored settings
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            
            if (user == null || string.IsNullOrEmpty(user.AzureDevOpsOrganization))
            {
                return BadRequest(new { message = "Azure DevOps organization is not configured. Please set it in Settings." });
            }

            string accessToken;
            bool useBasicAuth = false;

            // Use stored PAT if available
            if (!string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
            {
                var credentials = Convert.ToBase64String(
                    System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
                accessToken = credentials;
                useBasicAuth = true;
                _logger.LogInformation("Using stored PAT for fetching Azure DevOps teams");
            }
            else
            {
                // Fall back to OAuth token
                var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(
                    userId, ProviderTypes.AzureDevOps, cancellationToken);

                if (linkedProvider == null)
                {
                    return BadRequest(new { 
                        message = "Azure DevOps is not configured. Please add your PAT in Settings.",
                        requiresPat = true 
                    });
                }

                accessToken = linkedProvider.AccessToken;
            }

            var teams = await _azureDevOpsService.GetTeamsAsync(
                accessToken, 
                user.AzureDevOpsOrganization,
                projectName,
                cancellationToken, 
                useBasicAuth);

            return Ok(teams);
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "Azure DevOps authentication failed for teams");
            return BadRequest(new { message = ex.Message });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching Azure DevOps teams for project {Project}", projectName);
            return StatusCode(500, new { message = "Failed to fetch teams" });
        }
    }

    /// <summary>
    /// All area nodes from the project Areas tree (id for WIQL, path label for the UI).
    /// </summary>
    [HttpGet("azure-devops/projects/{projectName}/area-paths")]
    [Authorize]
    public async Task<IActionResult> GetAzureDevOpsAreaPaths(string projectName, CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        try
        {
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);

            if (user == null || string.IsNullOrEmpty(user.AzureDevOpsOrganization))
            {
                return BadRequest(new { message = "Azure DevOps organization is not configured. Please set it in Settings." });
            }

            string accessToken;
            bool useBasicAuth = false;

            if (!string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
            {
                var credentials = Convert.ToBase64String(
                    System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
                accessToken = credentials;
                useBasicAuth = true;
                _logger.LogInformation("Using stored PAT for Azure DevOps area paths");
            }
            else
            {
                var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(
                    userId, ProviderTypes.AzureDevOps, cancellationToken);

                if (linkedProvider == null)
                {
                    return BadRequest(new
                    {
                        message = "Azure DevOps is not configured. Please add your PAT in Settings.",
                        requiresPat = true
                    });
                }

                accessToken = linkedProvider.AccessToken;
            }

            var paths = await _azureDevOpsService.GetProjectAreaPathsAsync(
                accessToken,
                user.AzureDevOpsOrganization,
                projectName,
                cancellationToken,
                useBasicAuth);

            return Ok(paths);
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "Azure DevOps authentication failed for area paths");
            return BadRequest(new { message = ex.Message });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching Azure DevOps area paths for project {Project}", projectName);
            return StatusCode(500, new { message = "Failed to fetch area paths" });
        }
    }

    /// <summary>
    /// All iteration nodes from the project Iterations tree (id for <c>System.IterationId</c>, path for the UI).
    /// </summary>
    [HttpGet("azure-devops/projects/{projectName}/iteration-paths")]
    [Authorize]
    public async Task<IActionResult> GetAzureDevOpsIterationPaths(string projectName, CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        try
        {
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);

            if (user == null || string.IsNullOrEmpty(user.AzureDevOpsOrganization))
            {
                return BadRequest(new { message = "Azure DevOps organization is not configured. Please set it in Settings." });
            }

            string accessToken;
            bool useBasicAuth = false;

            if (!string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
            {
                var credentials = Convert.ToBase64String(
                    System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
                accessToken = credentials;
                useBasicAuth = true;
                _logger.LogInformation("Using stored PAT for Azure DevOps iteration paths");
            }
            else
            {
                var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(
                    userId, ProviderTypes.AzureDevOps, cancellationToken);

                if (linkedProvider == null)
                {
                    return BadRequest(new
                    {
                        message = "Azure DevOps is not configured. Please add your PAT in Settings.",
                        requiresPat = true
                    });
                }

                accessToken = linkedProvider.AccessToken;
            }

            var paths = await _azureDevOpsService.GetProjectIterationPathsAsync(
                accessToken,
                user.AzureDevOpsOrganization,
                projectName,
                cancellationToken,
                useBasicAuth);

            return Ok(paths);
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "Azure DevOps authentication failed for iteration paths");
            return BadRequest(new { message = ex.Message });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching Azure DevOps iteration paths for project {Project}", projectName);
            return StatusCode(500, new { message = "Failed to fetch iteration paths" });
        }
    }

    /// <summary>
    /// Get work items (Epics, Features, User Stories) from Azure DevOps project
    /// </summary>
    [HttpPost("azure-devops/work-items")]
    [Authorize]
    public async Task<IActionResult> GetAzureDevOpsWorkItems(
        [FromBody] AzureDevOpsWorkItemsRequest request,
        CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        try
        {
            // Get user to access stored settings
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            
            string accessToken;
            bool useBasicAuth = false;

            // Priority: 1. User's stored PAT, 2. Request PAT, 3. OAuth token
            if (user != null && !string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
            {
                // Use stored PAT from settings
                var credentials = Convert.ToBase64String(
                    System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
                accessToken = credentials;
                useBasicAuth = true;
                _logger.LogInformation("Using stored PAT for Azure DevOps work items");
            }
            else if (!string.IsNullOrEmpty(request.PersonalAccessToken))
            {
                // PAT authentication uses Basic auth with base64 encoded ":PAT"
                var credentials = Convert.ToBase64String(
                    System.Text.Encoding.ASCII.GetBytes($":{request.PersonalAccessToken}"));
                accessToken = credentials;
                useBasicAuth = true;
                _logger.LogInformation("Using request PAT for Azure DevOps work items");
            }
            else
            {
                // Get OAuth token from linked provider
                var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(
                    userId, ProviderTypes.AzureDevOps, cancellationToken);

                if (linkedProvider == null)
                {
                    return BadRequest(new { 
                        message = "Azure DevOps is not configured. Please add your PAT in Settings.",
                        requiresPat = true 
                    });
                }

                accessToken = linkedProvider.AccessToken;
            }

            // Get organization: 1. From request, 2. From user's stored settings
            var organizationName = request.OrganizationName;
            if (string.IsNullOrEmpty(organizationName) && user != null)
            {
                organizationName = user.AzureDevOpsOrganization;
            }
            
            if (string.IsNullOrEmpty(organizationName))
            {
                return BadRequest(new { message = "Organization name is required. Please configure it in Settings." });
            }

            var teamId = string.IsNullOrWhiteSpace(request.TeamId) ? null : request.TeamId.Trim();

            var includeSubAreas = request.IncludeDescendantAreaPaths is not false;
            var areaNodeId = request.AreaNodeId is > 0 ? request.AreaNodeId : null;
            var areaOverride = areaNodeId is not null || string.IsNullOrWhiteSpace(request.AreaPath)
                ? null
                : request.AreaPath!.Trim();
            var workItems = await _azureDevOpsService.GetWorkItemsAsync(
                accessToken,
                organizationName,
                request.ProjectName,
                teamId,
                areaOverride,
                areaNodeId,
                cancellationToken,
                useBasicAuth,
                includeSubAreas);

            return Ok(workItems);
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "Azure DevOps authentication failed for work items");
            return BadRequest(new { 
                message = ex.Message, 
                requiresPat = true 
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch work items from Azure DevOps for user {UserId}", userId);
            return BadRequest(new { message = $"Failed to fetch work items: {ex.Message}" });
        }
    }

    /// <summary>
    /// Request body for fetching GitHub issues
    /// </summary>
    public class GitHubIssuesRequest
    {
        public required string Owner { get; set; }
        public required string Repo { get; set; }
    }

    /// <summary>
    /// Get issues and milestones from a GitHub repository
    /// </summary>
    [HttpPost("github/issues")]
    [Authorize]
    public async Task<IActionResult> GetGitHubIssues(
        [FromBody] GitHubIssuesRequest request,
        CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        try
        {
            var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(
                userId, ProviderTypes.GitHub, cancellationToken);
            string? accessToken = linkedProvider?.AccessToken;
            if (string.IsNullOrEmpty(accessToken))
            {
                var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
                accessToken = user?.GitHubAccessToken;
            }

            if (!string.IsNullOrEmpty(accessToken))
            {
                var issues = await _gitHubService.GetIssuesAsync(
                    accessToken,
                    request.Owner,
                    request.Repo,
                    cancellationToken);
                return Ok(issues);
            }

            // No GitHub connected: fetch issues for public repos via unauthenticated API
            var issuesPublic = await _gitHubService.GetIssuesPublicAsync(
                request.Owner,
                request.Repo,
                cancellationToken);
            return Ok(issuesPublic);
        }
        catch (Octokit.NotFoundException)
        {
            return BadRequest(new { message = "Repository not found or is private. Connect GitHub to import issues from private repos." });
        }
        catch (Octokit.ForbiddenException ex)
        {
            _logger.LogWarning(ex, "Forbidden when fetching issues for {Owner}/{Repo}", request.Owner, request.Repo);
            return BadRequest(new { message = $"GitHub API access denied (may be rate-limited or blocked by proxy): {ex.Message}" });
        }
        catch (HttpRequestException ex)
        {
            _logger.LogError(ex, "Network error fetching issues for {Owner}/{Repo}", request.Owner, request.Repo);
            return BadRequest(new { message = $"Network error reaching GitHub API (enterprise proxy/SSL issue?): {ex.Message}" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch issues from GitHub for user {UserId}", userId);
            return BadRequest(new { message = $"Failed to fetch issues: {ex.Message}" });
        }
    }

    /// <summary>
    /// Analyze a repository and generate work items (Epics, Features, User Stories, Tasks)
    /// Uses AI to analyze the repository structure and generate structured work items
    /// </summary>
    /// <param name="repositoryId">The ID of the repository to analyze</param>
    /// <param name="request">Request body with optional repository content and save flag</param>
    [HttpPost("{repositoryId}/analyze")]
    public async Task<IActionResult> AnalyzeRepository(
        Guid repositoryId,
        [FromBody] AnalyzeRepositoryRequest? request,
        CancellationToken cancellationToken)
    {
        var command = new AnalyzeRepositoryCommand(repositoryId, request?.RepositoryContent);
        var analysisResult = await _mediator.Send(command, cancellationToken);

        // Optionally save the analysis results to the database
        if (request?.SaveResults == true)
        {
            var saveCommand = new SaveAnalysisResultsCommand(repositoryId, analysisResult);
            var itemsSaved = await _mediator.Send(saveCommand, cancellationToken);
            
            return Ok(new 
            { 
                analysis = analysisResult,
                itemsSaved = itemsSaved,
                message = $"Analysis completed and {itemsSaved} work items saved to database"
            });
        }

        return Ok(analysisResult);
    }

    /// <summary>
    /// Save analysis results (Epics, Features, User Stories, Tasks) to the database
    /// </summary>
    /// <param name="repositoryId">The ID of the repository</param>
    /// <param name="analysisResult">The analysis result to save</param>
    [HttpPost("{repositoryId}/analyze/save")]
    public async Task<IActionResult> SaveAnalysisResults(
        Guid repositoryId,
        [FromBody] RepositoryAnalysisResult analysisResult,
        CancellationToken cancellationToken)
    {
        var command = new SaveAnalysisResultsCommand(repositoryId, analysisResult);
        var itemsSaved = await _mediator.Send(command, cancellationToken);

        return Ok(new 
        { 
            itemsSaved = itemsSaved,
            message = $"Successfully saved {itemsSaved} work items to database"
        });
    }

    /// <summary>
    /// Create a pull request for a repository
    /// Uses the authenticated user's linked provider token
    /// </summary>
    [HttpPost("{repositoryId}/pull-requests")]
    [Authorize]
    public async Task<IActionResult> CreatePullRequest(
        Guid repositoryId,
        [FromBody] CreatePullRequestRequest request,
        CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var repository = await _repositoryRepository.GetByIdIfAccessibleAsync(repositoryId, userId, cancellationToken);
        if (repository == null)
        {
            return NotFound("Repository not found");
        }

        // Handle based on provider
        if (repository.Provider == "GitHub")
        {
            return await CreateGitHubPullRequest(userId, repository, request, cancellationToken);
        }
        else if (repository.Provider == "AzureDevOps")
        {
            return await CreateAzureDevOpsPullRequest(userId, repository, request, cancellationToken);
        }
        else
        {
            return BadRequest($"Unsupported provider: {repository.Provider}");
        }
    }

    private async Task<IActionResult> CreateGitHubPullRequest(
        Guid userId,
        Repository repository,
        CreatePullRequestRequest request,
        CancellationToken cancellationToken)
    {
        // Get GitHub token from linked providers first, then fallback to legacy
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
        string? accessToken = linkedProvider?.AccessToken;

        if (string.IsNullOrWhiteSpace(accessToken))
        {
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            accessToken = user?.GitHubAccessToken;
        }

        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return BadRequest("GitHub is not connected. Please link your GitHub account first.");
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 2)
        {
            return BadRequest("Invalid repository full name");
        }

        var owner = parts[0];
        var repo = parts[1];

        try
        {
            var pr = await _gitHubService.CreatePullRequestAsync(
                accessToken,
                owner,
                repo,
                request.HeadBranch,
                request.BaseBranch,
                request.Title,
                request.Body,
                cancellationToken);

            return Ok(pr);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create GitHub pull request for {RepositoryId}", repository.Id);
            return BadRequest(ex.Message);
        }
    }

    private async Task<IActionResult> CreateAzureDevOpsPullRequest(
        Guid userId,
        Repository repository,
        CreatePullRequestRequest request,
        CancellationToken cancellationToken)
    {
        // Use the helper method that properly handles PAT vs OAuth
        var (accessToken, useBasicAuth) = await GetAzureDevOpsAccessToken(userId, cancellationToken);
        
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return BadRequest("Azure DevOps is not connected. Please link your Azure DevOps account or configure a PAT in Settings.");
        }

        // Parse Azure DevOps full name format: organization/project/repo
        var parts = repository.FullName.Split('/');
        if (parts.Length != 3)
        {
            return BadRequest("Invalid Azure DevOps repository full name format. Expected: organization/project/repo");
        }

        var organization = parts[0];
        var project = parts[1];
        var repoName = parts[2];

        try
        {
            var pr = await _azureDevOpsService.CreatePullRequestAsync(
                accessToken,
                organization,
                project,
                repoName,
                request.HeadBranch,
                request.BaseBranch,
                request.Title,
                request.Body,
                request.WorkItemIds,
                cancellationToken,
                useBasicAuth);

            return Ok(new
            {
                Url = pr.Url,
                Number = pr.PullRequestId,
                Title = pr.Title
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create Azure DevOps pull request for {RepositoryId}", repository.Id);
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Request body for repository analysis
    /// </summary>
    public class AnalyzeRepositoryRequest
    {
        public string? RepositoryContent { get; set; }
        public bool SaveResults { get; set; } = false;
    }

    /// <summary>
    /// Request body for Azure DevOps sync
    /// </summary>
    public class AzureDevOpsSyncRequest
    {
        /// <summary>
        /// Optional: Azure DevOps organization name (e.g., 'myorg' from dev.azure.com/myorg)
        /// If not provided, will try to auto-discover organizations (may not work with Entra ID)
        /// </summary>
        public string? OrganizationName { get; set; }
        
        /// <summary>
        /// Optional: Personal Access Token (PAT) for Azure DevOps authentication
        /// If provided, will use PAT instead of OAuth token
        /// </summary>
        public string? PersonalAccessToken { get; set; }
    }

    /// <summary>
    /// Get repository file tree (directory listing)
    /// </summary>
    [HttpGet("{repositoryId}/tree")]
    [Authorize]
    public async Task<IActionResult> GetRepositoryTree(
        Guid repositoryId,
        [FromQuery] string? path = null,
        [FromQuery] string? branch = null,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var repository = await _repositoryRepository.GetByIdIfAccessibleAsync(repositoryId, userId, cancellationToken);
        if (repository == null)
        {
            return NotFound("Repository not found");
        }

        try
        {
            if (repository.Provider == "GitHub")
            {
                return await GetGitHubTree(userId, repository, path, branch, cancellationToken);
            }
            else if (repository.Provider == "AzureDevOps")
            {
                return await GetAzureDevOpsTree(userId, repository, path, branch, cancellationToken);
            }
            else if (repository.Provider == "Unpublished")
            {
                return await GetUnpublishedTree(repository, path, branch, cancellationToken);
            }
            else
            {
                return BadRequest($"Unsupported provider: {repository.Provider}");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get repository tree for {RepositoryId}", repositoryId);
            return BadRequest(new { message = ex.Message });
        }
    }

    /// <summary>
    /// Get file content from repository
    /// </summary>
    [HttpGet("{repositoryId}/file")]
    [Authorize]
    public async Task<IActionResult> GetFileContent(
        Guid repositoryId,
        [FromQuery] string path,
        [FromQuery] string? branch = null,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var repository = await _repositoryRepository.GetByIdIfAccessibleAsync(repositoryId, userId, cancellationToken);
        if (repository == null)
        {
            return NotFound("Repository not found");
        }

        if (string.IsNullOrEmpty(path))
        {
            return BadRequest("File path is required");
        }

        try
        {
            if (repository.Provider == "GitHub")
            {
                return await GetGitHubFileContent(userId, repository, path, branch, cancellationToken);
            }
            else if (repository.Provider == "AzureDevOps")
            {
                return await GetAzureDevOpsFileContent(userId, repository, path, branch, cancellationToken);
            }
            else if (repository.Provider == "Unpublished")
            {
                return await GetUnpublishedFileContent(repository, path, branch, cancellationToken);
            }
            else
            {
                return BadRequest($"Unsupported provider: {repository.Provider}");
            }
        }
        catch (FileNotFoundException)
        {
            return NotFound($"File not found: {path}");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get file content for {RepositoryId}/{Path}", repositoryId, path);
            return BadRequest(new { message = ex.Message });
        }
    }

    /// <summary>
    /// Get repository branches
    /// </summary>
    [HttpGet("{repositoryId}/branches")]
    [Authorize]
    public async Task<IActionResult> GetBranches(
        Guid repositoryId,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var repository = await _repositoryRepository.GetByIdIfAccessibleAsync(repositoryId, userId, cancellationToken);
        if (repository == null)
        {
            return NotFound("Repository not found");
        }

        try
        {
            if (repository.Provider == "GitHub")
            {
                return await GetGitHubBranches(userId, repository, cancellationToken);
            }
            else if (repository.Provider == "AzureDevOps")
            {
                return await GetAzureDevOpsBranches(userId, repository, cancellationToken);
            }
            else if (repository.Provider == "Unpublished")
            {
                return Ok(_unpublishedFileStore.GetBranches(repository.DefaultBranch));
            }
            else
            {
                return BadRequest($"Unsupported provider: {repository.Provider}");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get branches for {RepositoryId}", repositoryId);
            return BadRequest(new { message = ex.Message });
        }
    }

    /// <summary>Save UTF-8 text to the server-local workspace of an unpublished project.</summary>
    [HttpPut("{repositoryId:guid}/unpublished/file")]
    [Authorize]
    public async Task<IActionResult> PutUnpublishedFile(
        Guid repositoryId,
        [FromBody] UnpublishedWriteFileRequest? request,
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        if (request == null || string.IsNullOrWhiteSpace(request.Path))
        {
            return BadRequest(new { message = "Path is required" });
        }

        var repository = await _repositoryRepository.GetByIdIfAccessibleAsync(repositoryId, userId, cancellationToken);
        if (repository == null)
        {
            return NotFound("Repository not found");
        }

        if (repository.Provider != "Unpublished")
        {
            return BadRequest(new { message = "Only local (unpublished) projects support this endpoint" });
        }

        try
        {
            await _unpublishedFileStore.EnsurePresentAsync(
                    repositoryId,
                    repository.Name,
                    repository.Description,
                    cancellationToken)
                .ConfigureAwait(false);
            await _unpublishedFileStore
                .WriteTextFileAsync(repositoryId, request.Path.Trim(), request.Content ?? string.Empty, cancellationToken)
                .ConfigureAwait(false);
            return NoContent();
        }
        catch (ArgumentException ex)
        {
            return BadRequest(new { message = ex.Message });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to write unpublished file {RepositoryId} {Path}", repositoryId, request.Path);
            return BadRequest(new { message = ex.Message });
        }
    }

    private async Task<IActionResult> GetGitHubTree(Guid userId, Repository repository, string? path, string? branch, CancellationToken cancellationToken)
    {
        var parts = repository.FullName.Split('/');
        if (parts.Length != 2)
        {
            return BadRequest("Invalid repository full name");
        }

        var accessToken = await GetGitHubAccessToken(userId, cancellationToken);
        try
        {
            if (!string.IsNullOrEmpty(accessToken))
            {
                var tree = await _gitHubService.GetRepositoryTreeAsync(accessToken, parts[0], parts[1], path, branch, cancellationToken);
                return Ok(tree);
            }
            var treePublic = await _gitHubService.GetRepositoryTreePublicAsync(parts[0], parts[1], path, branch, cancellationToken);
            return Ok(treePublic);
        }
        catch (Octokit.NotFoundException)
        {
            return BadRequest(new { message = "Repository not found or is private. Connect GitHub to browse private repos." });
        }
        catch (Octokit.ForbiddenException)
        {
            return BadRequest(new { message = "Repository may be private or access was denied. Connect GitHub to browse." });
        }
    }

    private async Task<IActionResult> GetAzureDevOpsTree(Guid userId, Repository repository, string? path, string? branch, CancellationToken cancellationToken)
    {
        var (accessToken, useBasicAuth) = await GetAzureDevOpsAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "Azure DevOps is not connected. Please link your Azure DevOps account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 3)
        {
            return BadRequest("Invalid Azure DevOps repository full name format. Expected: organization/project/repo");
        }

        var tree = await _azureDevOpsService.GetRepositoryTreeAsync(
            accessToken, parts[0], parts[1], parts[2], path, branch, cancellationToken, useBasicAuth);
        return Ok(tree);
    }

    private async Task<IActionResult> GetUnpublishedTree(Repository repository, string? path, string? branch, CancellationToken cancellationToken)
    {
        await _unpublishedFileStore
            .EnsurePresentAsync(repository.Id, repository.Name, repository.Description, cancellationToken)
            .ConfigureAwait(false);
        var tree = await _unpublishedFileStore
            .GetTreeAsync(repository.Id, path, branch, repository.DefaultBranch, cancellationToken)
            .ConfigureAwait(false);
        return Ok(tree);
    }

    private async Task<IActionResult> GetUnpublishedFileContent(Repository repository, string path, string? branch, CancellationToken cancellationToken)
    {
        await _unpublishedFileStore
            .EnsurePresentAsync(repository.Id, repository.Name, repository.Description, cancellationToken)
            .ConfigureAwait(false);
        var content = await _unpublishedFileStore
            .GetFileContentAsync(repository.Id, path, branch, repository.DefaultBranch, cancellationToken)
            .ConfigureAwait(false);
        return Ok(content);
    }

    private async Task<IActionResult> GetGitHubFileContent(Guid userId, Repository repository, string path, string? branch, CancellationToken cancellationToken)
    {
        var parts = repository.FullName.Split('/');
        if (parts.Length != 2)
        {
            return BadRequest("Invalid repository full name");
        }

        var accessToken = await GetGitHubAccessToken(userId, cancellationToken);
        try
        {
            if (!string.IsNullOrEmpty(accessToken))
            {
                var content = await _gitHubService.GetFileContentAsync(accessToken, parts[0], parts[1], path, branch, cancellationToken);
                return Ok(content);
            }
            var contentPublic = await _gitHubService.GetFileContentPublicAsync(parts[0], parts[1], path, branch, cancellationToken);
            return Ok(contentPublic);
        }
        catch (Octokit.NotFoundException)
        {
            return BadRequest(new { message = "File not found or repository is private. Connect GitHub to browse private repos." });
        }
        catch (Octokit.ForbiddenException)
        {
            return BadRequest(new { message = "Repository may be private or access was denied. Connect GitHub to browse." });
        }
    }

    private async Task<IActionResult> GetAzureDevOpsFileContent(Guid userId, Repository repository, string path, string? branch, CancellationToken cancellationToken)
    {
        var (accessToken, useBasicAuth) = await GetAzureDevOpsAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "Azure DevOps is not connected. Please link your Azure DevOps account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 3)
        {
            return BadRequest("Invalid Azure DevOps repository full name format. Expected: organization/project/repo");
        }

        var content = await _azureDevOpsService.GetFileContentAsync(
            accessToken, parts[0], parts[1], parts[2], path, branch, cancellationToken, useBasicAuth);
        return Ok(content);
    }

    private async Task<IActionResult> GetGitHubBranches(Guid userId, Repository repository, CancellationToken cancellationToken)
    {
        var parts = repository.FullName.Split('/');
        if (parts.Length != 2)
        {
            return BadRequest("Invalid repository full name");
        }

        var accessToken = await GetGitHubAccessToken(userId, cancellationToken);
        try
        {
            if (!string.IsNullOrEmpty(accessToken))
            {
                var branches = await _gitHubService.GetBranchesAsync(accessToken, parts[0], parts[1], cancellationToken);
                return Ok(branches);
            }
            var branchesPublic = await _gitHubService.GetBranchesPublicAsync(parts[0], parts[1], cancellationToken);
            return Ok(branchesPublic);
        }
        catch (Octokit.NotFoundException)
        {
            return BadRequest(new { message = "Repository not found or is private. Connect GitHub to browse private repos." });
        }
        catch (Octokit.ForbiddenException)
        {
            return BadRequest(new { message = "Repository may be private or access was denied. Connect GitHub to browse." });
        }
    }

    private async Task<IActionResult> GetAzureDevOpsBranches(Guid userId, Repository repository, CancellationToken cancellationToken)
    {
        var (accessToken, useBasicAuth) = await GetAzureDevOpsAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "Azure DevOps is not connected. Please link your Azure DevOps account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 3)
        {
            return BadRequest("Invalid Azure DevOps repository full name format. Expected: organization/project/repo");
        }

        var branches = await _azureDevOpsService.GetBranchesAsync(
            accessToken, parts[0], parts[1], parts[2], cancellationToken, useBasicAuth);
        return Ok(branches);
    }

    private async Task<string?> GetGitHubAccessToken(Guid userId, CancellationToken cancellationToken)
    {
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
        if (!string.IsNullOrEmpty(linkedProvider?.AccessToken))
        {
            return linkedProvider.AccessToken;
        }

        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        return user?.GitHubAccessToken;
    }

    private async Task<(string? accessToken, bool useBasicAuth)> GetAzureDevOpsAccessToken(Guid userId, CancellationToken cancellationToken)
    {
        _logger.LogInformation("Getting Azure DevOps access token for user {UserId}", userId);
        
        // PRIORITY: Use PAT if user has configured one (PAT has better code access permissions)
        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        _logger.LogInformation("User {UserId} has PAT: {HasPat}, Organization: {Org}", 
            userId, 
            !string.IsNullOrEmpty(user?.AzureDevOpsAccessToken),
            user?.AzureDevOpsOrganization ?? "null");
            
        if (user != null && !string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
        {
            // PAT needs to be base64 encoded with ":PAT" format for Basic auth
            var encodedPat = Convert.ToBase64String(
                System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
            _logger.LogInformation("Using stored PAT for user {UserId}", userId);
            return (encodedPat, true);
        }

        // Fall back to OAuth token from LinkedProvider
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.AzureDevOps, cancellationToken);
        if (linkedProvider != null && !string.IsNullOrEmpty(linkedProvider.AccessToken))
        {
            _logger.LogInformation("Using OAuth token from LinkedProvider for user {UserId}", userId);
            return (linkedProvider.AccessToken, false);
        }

        _logger.LogWarning("No Azure DevOps token found for user {UserId}", userId);
        return (null, false);
    }

    /// <summary>
    /// Get pull requests for a repository
    /// </summary>
    [HttpGet("{repositoryId}/pull-requests")]
    [Authorize]
    public async Task<IActionResult> GetPullRequests(
        Guid repositoryId,
        [FromQuery] string? state = "all",
        CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized("User ID not found in token");
        }

        var repository = await _repositoryRepository.GetByIdIfAccessibleAsync(repositoryId, userId, cancellationToken);
        if (repository == null)
        {
            return NotFound("Repository not found");
        }

        try
        {
            if (repository.Provider == "GitHub")
            {
                return await GetGitHubPullRequests(userId, repository, state, cancellationToken);
            }
            else if (repository.Provider == "AzureDevOps")
            {
                return await GetAzureDevOpsPullRequests(userId, repository, state, cancellationToken);
            }
            else if (repository.Provider == "Unpublished")
            {
                return Ok(new List<PullRequestDto>());
            }
            else
            {
                return BadRequest($"Unsupported provider: {repository.Provider}");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get pull requests for {RepositoryId}", repositoryId);
            return BadRequest(new { message = ex.Message });
        }
    }

    private async Task<IActionResult> GetGitHubPullRequests(Guid userId, Repository repository, string? state, CancellationToken cancellationToken)
    {
        var accessToken = await GetGitHubAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "GitHub is not connected. Please link your GitHub account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 2)
        {
            return BadRequest("Invalid repository full name");
        }

        var pullRequests = await _gitHubService.GetPullRequestsAsync(accessToken, parts[0], parts[1], state, cancellationToken);
        return Ok(pullRequests);
    }

    private async Task<IActionResult> GetAzureDevOpsPullRequests(Guid userId, Repository repository, string? state, CancellationToken cancellationToken)
    {
        var (accessToken, useBasicAuth) = await GetAzureDevOpsAccessToken(userId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
        {
            return BadRequest(new { message = "Azure DevOps is not connected. Please link your Azure DevOps account first." });
        }

        var parts = repository.FullName.Split('/');
        if (parts.Length != 3)
        {
            return BadRequest("Invalid Azure DevOps repository full name format. Expected: organization/project/repo");
        }

        var pullRequests = await _azureDevOpsService.GetPullRequestsAsync(
            accessToken, parts[0], parts[1], parts[2], state, cancellationToken, useBasicAuth);
        return Ok(pullRequests);
    }

    /// <summary>
    /// Get the authenticated clone URL for a repository (with PAT embedded for private repos)
    /// </summary>
    [HttpGet("{repositoryId}/clone-url")]
    [Authorize]
    public async Task<IActionResult> GetAuthenticatedCloneUrl(Guid repositoryId, CancellationToken cancellationToken)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized();

        var repository = await _repositoryRepository.GetByIdIfAccessibleAsync(repositoryId, userId, cancellationToken);
        if (repository == null)
            return NotFound("Repository not found");

        var cloneUrl = repository.CloneUrl;
        
        // For Azure DevOps, embed PAT in URL
        if (repository.Provider == ProviderTypes.AzureDevOps)
        {
            var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
            if (user != null && !string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
            {
                // Azure DevOps clone URL format with PAT: https://{PAT}@dev.azure.com/...
                // Original URL: https://dev.azure.com/{org}/{project}/_git/{repo}
                if (cloneUrl.StartsWith("https://dev.azure.com/"))
                {
                    cloneUrl = cloneUrl.Replace("https://dev.azure.com/", $"https://{user.AzureDevOpsAccessToken}@dev.azure.com/");
                    _logger.LogInformation("Created authenticated clone URL for Azure DevOps repository {RepoId}", repositoryId);
                }
                // Alternative format: https://{org}@dev.azure.com/{org}/{project}/_git/{repo}
                else if (cloneUrl.Contains("@dev.azure.com/"))
                {
                    // Replace the existing token/org prefix with PAT
                    var atIndex = cloneUrl.IndexOf("@dev.azure.com/");
                    cloneUrl = $"https://{user.AzureDevOpsAccessToken}{cloneUrl.Substring(cloneUrl.IndexOf("@dev.azure.com/"))}";
                    _logger.LogInformation("Created authenticated clone URL for Azure DevOps repository {RepoId} (alternate format)", repositoryId);
                }
            }
            else
            {
                _logger.LogWarning("No Azure DevOps PAT found for user {UserId}, clone may fail for private repos", userId);
            }
        }
        // For GitHub, embed token in URL
        else if (repository.Provider == ProviderTypes.GitHub)
        {
            var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, ProviderTypes.GitHub, cancellationToken);
            if (linkedProvider != null && !string.IsNullOrEmpty(linkedProvider.AccessToken))
            {
                // GitHub clone URL format with token: https://{token}@github.com/...
                if (cloneUrl.StartsWith("https://github.com/"))
                {
                    cloneUrl = cloneUrl.Replace("https://github.com/", $"https://{linkedProvider.AccessToken}@github.com/");
                    _logger.LogInformation("Created authenticated clone URL for GitHub repository {RepoId}", repositoryId);
                }
            }
        }

        // Local (unpublished) projects: no git remote — signed zip URL for sandbox bootstrap; clone URL empty
        // GitHub: archive URL (zipball) so sandbox can download without git when clone is blocked
        string? archiveUrl = null;
        if (repository.Provider == "Unpublished")
        {
            var opt = _unpublishedOptions.Value;
            var secret = !string.IsNullOrEmpty(opt.ArchiveSigningKey)
                ? opt.ArchiveSigningKey!
                : _configuration["JWT:SecretKey"] ?? string.Empty;
            if (string.IsNullOrEmpty(secret))
            {
                return StatusCode(500, new
                {
                    message = "Configure JWT:SecretKey or UnpublishedRepositories:ArchiveSigningKey for unpublished sandboxes."
                });
            }

            var exp = DateTimeOffset.UtcNow.AddHours(2).ToUnixTimeSeconds();
            var sig = UnpublishedArchiveToken.Sign(secret, repository.Id, exp);
            var baseUrl = opt.DownloadBaseUrl?.Trim();
            if (string.IsNullOrEmpty(baseUrl))
            {
                var req = _httpContextAccessor.HttpContext?.Request;
                if (req is null)
                {
                    return StatusCode(500, new
                    {
                        message = "Set UnpublishedRepositories:DownloadBaseUrl to the API URL reachable from the sandbox (no HTTP request context to infer it)."
                    });
                }

                // The sandbox is another Docker container: localhost/127.0.0.1 would not reach the
                // host where the API runs. Use host.docker.internal (Docker Desktop) or
                // UnpublishedRepositories:DownloadBaseUrl / extra_hosts on the sandbox container (Linux).
                baseUrl = BuildApiBaseForSandboxUnpublishedDownload(req);
            }

            archiveUrl =
                $"{baseUrl.TrimEnd('/')}/api/repositories/{repositoryId}/unpublished/sandbox-archive?exp={exp}&sig={Uri.EscapeDataString(sig)}";
            cloneUrl = string.Empty;
        }
        else if (repository.Provider == ProviderTypes.GitHub)
        {
            var parts = repository.FullName.Split('/');
            if (parts.Length == 2)
            {
                var branch = repository.DefaultBranch ?? "main";
                archiveUrl = $"https://api.github.com/repos/{parts[0]}/{parts[1]}/zipball/{branch}";
            }
        }

        return Ok(new { cloneUrl, archiveUrl });
    }

    /// <summary>Anonymous download: HMAC-protected zip of an unpublished project (for sandbox container bootstrap).</summary>
    [HttpGet("{repositoryId:guid}/unpublished/sandbox-archive")]
    [AllowAnonymous]
    public async Task<IActionResult> GetUnpublishedSandboxArchive(
        Guid repositoryId,
        [FromQuery] long exp,
        [FromQuery] string? sig,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(sig))
        {
            return BadRequest(new { message = "Missing signature" });
        }

        var opt = _unpublishedOptions.Value;
        var secret = !string.IsNullOrEmpty(opt.ArchiveSigningKey)
            ? opt.ArchiveSigningKey!
            : _configuration["JWT:SecretKey"] ?? string.Empty;
        if (string.IsNullOrEmpty(secret))
        {
            return Unauthorized(new { message = "Server misconfiguration" });
        }

        if (!UnpublishedArchiveToken.Validate(secret, repositoryId, exp, sig, out var err))
        {
            return Unauthorized(new { message = err ?? "Invalid token" });
        }

        var repository = await _repositoryRepository.GetByIdAsync(repositoryId, cancellationToken);
        if (repository is null)
        {
            return NotFound(new { message = "Repository not found" });
        }

        if (repository.Provider != "Unpublished")
        {
            return Forbid();
        }

        await _unpublishedFileStore
            .EnsurePresentAsync(
                repositoryId,
                repository.Name,
                repository.Description,
                cancellationToken)
            .ConfigureAwait(false);
        var stream = await _unpublishedFileStore
            .OpenArchiveAsZipStreamAsync(repositoryId, cancellationToken)
            .ConfigureAwait(false);
        return File(stream, "application/zip", "project.zip");
    }

    /// <summary>Replace unpublished project files from a zip (from sandbox "Commit" flow).</summary>
    [HttpPost("{repositoryId:guid}/unpublished/import-zip")]
    [Authorize]
    [RequestSizeLimit(104_857_600)]
    public async Task<IActionResult> ImportUnpublishedFromZip(
        Guid repositoryId,
        IFormFile? file,
        CancellationToken cancellationToken)
    {
        if (file is null || file.Length == 0)
        {
            return BadRequest(new { message = "Expected multipart file 'file' with a zip body" });
        }

        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized();
        }

        var repository = await _repositoryRepository
            .GetByIdIfAccessibleAsync(repositoryId, userId, cancellationToken)
            .ConfigureAwait(false);
        if (repository is null)
        {
            return NotFound(new { message = "Repository not found" });
        }

        if (repository.Provider != "Unpublished")
        {
            return BadRequest(new { message = "This endpoint applies only to unpublished (local) projects" });
        }

        await using var stream = file.OpenReadStream();
        await _unpublishedFileStore
            .ReplaceTreeFromZipAsync(repositoryId, stream, cancellationToken)
            .ConfigureAwait(false);
        return Ok(new { message = "Project files updated" });
    }

    /// <summary>
    /// Base URL for the API as seen from inside a sandbox container (must not use loopback).
    /// </summary>
    private static string BuildApiBaseForSandboxUnpublishedDownload(HttpRequest req)
    {
        var pathBase = req.PathBase;
        if (IsLoopbackHost(req.Host.Host))
        {
            var port = req.Host.Port;
            var portSegment = port.HasValue ? $":{port.Value}" : "";
            return $"{req.Scheme}://host.docker.internal{portSegment}{pathBase}";
        }

        return $"{req.Scheme}://{req.Host}{pathBase}";
    }

    private static bool IsLoopbackHost(string host) =>
        host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
        || host.Equals("127.0.0.1", StringComparison.Ordinal)
        || host.Equals("::1", StringComparison.Ordinal)
        || host.Equals("[::1]", StringComparison.Ordinal);
}
