namespace DevPilot.API.Controllers;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

/// <summary>Admin-curated named agent rule templates, readable by all authenticated users.</summary>
[ApiController]
[Route("api/[controller]")]
[Authorize]
public class GlobalAgentRulesController : ControllerBase
{
    private const int NameMax = 128;
    private const int BodyMax = 1_000_000;

    private readonly IGlobalAgentRuleRepository _repo;
    private readonly ILogger<GlobalAgentRulesController> _logger;

    public GlobalAgentRulesController(IGlobalAgentRuleRepository repo, ILogger<GlobalAgentRulesController> logger)
    {
        _repo = repo;
        _logger = logger;
    }

    /// <summary>All users (repositories can copy these by name into local profiles).</summary>
    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<GlobalAgentRuleResponse>>> List(CancellationToken cancellationToken = default)
    {
        var list = await _repo.GetAllAsync(cancellationToken);
        return Ok(list.Select(Map).ToList());
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<GlobalAgentRuleResponse>> GetById(Guid id, CancellationToken cancellationToken = default)
    {
        var e = await _repo.GetByIdAsync(id, cancellationToken);
        if (e is null) return NotFound();
        return Ok(Map(e));
    }

    [HttpPost]
    [Authorize(Roles = "admin")]
    public async Task<ActionResult<GlobalAgentRuleResponse>> Create(
        [FromBody] SaveGlobalAgentRuleRequest? request,
        CancellationToken cancellationToken = default)
    {
        if (request is null) return BadRequest();
        var name = (request.Name ?? string.Empty).Trim();
        if (name.Length is 0 or > NameMax) return BadRequest(new { message = "Name is required (max 128 characters)." });
        if (string.IsNullOrEmpty(request.Body) || request.Body.Length > BodyMax) return BadRequest(new { message = "Body is required (max 1,000,000 characters)." });
        if (await _repo.NameExistsAsync(name, null, cancellationToken)) return Conflict(new { message = "A global rule with this name already exists." });
        var sort = request.SortOrder;
        var created = new GlobalAgentRule(name, request.Body, sort);
        await _repo.AddAsync(created, cancellationToken);
        _logger.LogInformation("Global agent rule created: {Name} ({Id})", name, created.Id);
        return Ok(Map(created));
    }

    [HttpPut("{id:guid}")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> Update(
        Guid id,
        [FromBody] SaveGlobalAgentRuleRequest? request,
        CancellationToken cancellationToken = default)
    {
        if (request is null) return BadRequest();
        var name = (request.Name ?? string.Empty).Trim();
        if (name.Length is 0 or > NameMax) return BadRequest(new { message = "Name is required (max 128 characters)." });
        if (string.IsNullOrEmpty(request.Body) || request.Body.Length > BodyMax) return BadRequest(new { message = "Body is required (max 1,000,000 characters)." });
        if (await _repo.NameExistsAsync(name, id, cancellationToken)) return Conflict(new { message = "A global rule with this name already exists." });
        try
        {
            await _repo.UpdateAsync(id, name, request.Body, request.SortOrder, cancellationToken);
        }
        catch (InvalidOperationException)
        {
            return NotFound();
        }

        _logger.LogInformation("Global agent rule updated: {Id}", id);
        return NoContent();
    }

    [HttpDelete("{id:guid}")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken cancellationToken = default)
    {
        var e = await _repo.GetByIdAsync(id, cancellationToken);
        if (e is null) return NotFound();
        await _repo.DeleteAsync(id, cancellationToken);
        _logger.LogInformation("Global agent rule deleted: {Name} ({Id})", e.Name, id);
        return NoContent();
    }

    private static GlobalAgentRuleResponse Map(GlobalAgentRule e) => new(
        e.Id,
        e.Name,
        e.Body,
        e.SortOrder,
        e.CreatedAt,
        e.UpdatedAt);

    public record GlobalAgentRuleResponse(
        Guid Id,
        string Name,
        string Body,
        int SortOrder,
        DateTime CreatedAt,
        DateTime? UpdatedAt);

    public class SaveGlobalAgentRuleRequest
    {
        public string? Name { get; set; }
        public string? Body { get; set; }
        public int SortOrder { get; set; }
    }
}
