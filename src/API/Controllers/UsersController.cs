namespace DevPilot.API.Controllers;

using System.Security.Claims;
using DevPilot.Domain.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// User lookup for sharing and suggestions (e.g. suggest users when sharing a repository).
/// </summary>
[ApiController]
[Route("api/[controller]")]
[Authorize]
public class UsersController : ControllerBase
{
    private readonly IUserRepository _userRepository;
    private readonly ILogger<UsersController> _logger;

    public UsersController(IUserRepository userRepository, ILogger<UsersController> logger)
    {
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Suggest users by email or name (for share dialogs, etc.).
    /// Excludes the current user. Returns minimal fields: userId, email, name.
    /// </summary>
    /// <param name="q">Search query (email or name fragment)</param>
    /// <param name="limit">Max results (default 10, max 20)</param>
    [HttpGet("suggest")]
    public async Task<IActionResult> Suggest([FromQuery] string? q, [FromQuery] int limit = 10, CancellationToken cancellationToken = default)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var currentUserId))
            return Unauthorized();

        if (string.IsNullOrWhiteSpace(q))
            return Ok(Array.Empty<object>());

        var take = Math.Clamp(limit, 1, 20);
        var users = await _userRepository.SearchSuggestionsAsync(q.Trim(), take, currentUserId, cancellationToken);
        var result = users.Select(u => new { userId = u.Id, email = u.Email, name = u.Name });
        return Ok(result);
    }
}
