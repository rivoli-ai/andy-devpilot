namespace DevPilot.API.Controllers;

using System.Net.Http;
using System.Security.Claims;
using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class ArtifactController : ControllerBase
{
    private readonly IArtifactFeedConfigRepository _repo;
    private readonly IUserRepository _userRepo;
    private readonly IAzureDevOpsService _adoService;
    private readonly ILogger<ArtifactController> _logger;

    public ArtifactController(
        IArtifactFeedConfigRepository repo,
        IUserRepository userRepo,
        IAzureDevOpsService adoService,
        ILogger<ArtifactController> logger)
    {
        _repo = repo;
        _userRepo = userRepo;
        _adoService = adoService;
        _logger = logger;
    }

    // ── Browse Azure DevOps feeds (admin only — used when defining feeds) ─

    [HttpGet("feeds")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> BrowseFeeds([FromQuery] string organization, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(organization))
            return BadRequest(new { message = "Organization is required." });

        var userId = GetUserId();
        if (userId == null) return Unauthorized();

        var user = await _userRepo.GetByIdAsync(userId.Value, ct);
        if (user == null) return Unauthorized();

        if (string.IsNullOrEmpty(user.AzureDevOpsAccessToken))
            return BadRequest(new { message = "Azure DevOps PAT is not configured. Please set it in Settings." });

        var encodedPat = Convert.ToBase64String(
            System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));

        try
        {
            var feeds = await _adoService.GetFeedsAsync(organization, encodedPat, ct);
            return Ok(feeds);
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Azure DevOps list feeds failed for organization {Organization}", organization);
            if (ex.Message.Contains("Unauthorized", StringComparison.OrdinalIgnoreCase))
            {
                return BadRequest(new
                {
                    message =
                        "Azure DevOps returned 401 Unauthorized. Check the organization name, that your PAT is still valid, and that it can access Packaging feeds (e.g. Packaging > Read scope)."
                });
            }

            if (ex.Message.Contains("Forbidden", StringComparison.OrdinalIgnoreCase))
            {
                return BadRequest(new
                {
                    message =
                        "Azure DevOps returned 403 Forbidden. Your PAT may lack permission for this organization or for artifact feeds."
                });
            }

            return BadRequest(new { message = "Could not load feeds from Azure DevOps. Verify the organization and PAT, then try again." });
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { message = ex.Message });
        }
    }

    // ── Catalog: admins see all rows; others see shared (admin-defined) only ─

    [HttpGet]
    public async Task<IActionResult> GetAll(CancellationToken ct)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();
        var isAdmin = User.IsInRole("admin");
        var list = await _repo.GetAllVisibleAsync(userId.Value, isAdmin, ct);
        return Ok(list.Select(e => MapDto(e, isAdmin)).ToList());
    }

    [HttpPost]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> Create([FromBody] CreateArtifactFeedRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(new { message = "Name is required." });
        if (string.IsNullOrWhiteSpace(request.Organization))
            return BadRequest(new { message = "Organization is required." });
        if (string.IsNullOrWhiteSpace(request.FeedName))
            return BadRequest(new { message = "FeedName is required." });
        if (request.FeedType is not ("nuget" or "npm" or "pip"))
            return BadRequest(new { message = "FeedType must be 'nuget', 'npm', or 'pip'." });

        var userId = GetUserId();
        if (userId == null) return Unauthorized();

        var entity = new ArtifactFeedConfig(
            request.Name,
            request.Organization,
            request.FeedName,
            request.ProjectName,
            request.FeedType,
            request.IsEnabled ?? true,
            ownerUserId: null);

        entity = await _repo.AddAsync(entity, ct);
        _logger.LogInformation("Admin created shared artifact feed config: {Name} ({FeedType})", request.Name, request.FeedType);
        return Ok(MapDto(entity, isAdmin: true));
    }

    [HttpPatch("{id:guid}")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateArtifactFeedRequest request, CancellationToken ct)
    {
        var entity = await _repo.GetByIdAsync(id, ct);
        if (entity == null) return NotFound();

        entity.Update(
            request.Name,
            request.Organization,
            request.FeedName,
            request.ProjectName,
            request.FeedType);

        if (request.IsEnabled.HasValue)
            entity.SetEnabled(request.IsEnabled.Value);

        await _repo.UpdateAsync(entity, ct);
        return Ok(MapDto(entity, isAdmin: true));
    }

    [HttpDelete("{id:guid}")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var entity = await _repo.GetByIdAsync(id, ct);
        if (entity == null) return NotFound();

        await _repo.DeleteAsync(id, ct);
        return Ok(new { message = "Artifact feed config deleted" });
    }

    // ── Enabled shared feeds (sandboxes — all authenticated users) ─────

    [HttpGet("enabled")]
    public async Task<IActionResult> GetEnabled(CancellationToken ct)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();
        var list = await _repo.GetEnabledSharedAsync(ct);
        var isAdmin = User.IsInRole("admin");
        return Ok(list.Select(e => MapDto(e, isAdmin)).ToList());
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private Guid? GetUserId()
    {
        var claim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(claim, out var id) ? id : null;
    }

    private static ArtifactFeedDto MapDto(ArtifactFeedConfig entity, bool isAdmin)
    {
        var isShared = entity.OwnerUserId == null;
        return new ArtifactFeedDto
        {
            Id = entity.Id,
            Name = entity.Name,
            Organization = entity.Organization,
            FeedName = entity.FeedName,
            ProjectName = entity.ProjectName,
            FeedType = entity.FeedType,
            IsEnabled = entity.IsEnabled,
            OwnerUserId = entity.OwnerUserId,
            IsShared = isShared,
            CanManage = isAdmin,
        };
    }

    // ── DTOs ────────────────────────────────────────────────────────────

    public class ArtifactFeedDto
    {
        public Guid Id { get; set; }
        public required string Name { get; set; }
        public required string Organization { get; set; }
        public required string FeedName { get; set; }
        public string? ProjectName { get; set; }
        public required string FeedType { get; set; }
        public bool IsEnabled { get; set; }
        public Guid? OwnerUserId { get; set; }
        public bool IsShared { get; set; }
        public bool CanManage { get; set; }
    }

    public class CreateArtifactFeedRequest
    {
        public string? Name { get; set; }
        public string? Organization { get; set; }
        public string? FeedName { get; set; }
        public string? ProjectName { get; set; }
        public string? FeedType { get; set; }
        public bool? IsEnabled { get; set; }
    }

    public class UpdateArtifactFeedRequest
    {
        public string? Name { get; set; }
        public string? Organization { get; set; }
        public string? FeedName { get; set; }
        public string? ProjectName { get; set; }
        public string? FeedType { get; set; }
        public bool? IsEnabled { get; set; }
    }
}
