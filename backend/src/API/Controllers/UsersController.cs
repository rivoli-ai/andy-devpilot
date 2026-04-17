namespace DevPilot.API.Controllers;

using System.Security.Claims;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using DevPilot.Infrastructure.Auth;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;

/// <summary>
/// User lookup for sharing and suggestions (e.g. suggest users when sharing a repository).
/// </summary>
[ApiController]
[Route("api/[controller]")]
[Authorize]
public class UsersController : ControllerBase
{
    private readonly IUserRepository _userRepository;
    private readonly IConfiguration _configuration;
    private readonly AuthenticationService _authenticationService;
    private readonly ILogger<UsersController> _logger;

    public UsersController(
        IUserRepository userRepository,
        IConfiguration configuration,
        AuthenticationService authenticationService,
        ILogger<UsersController> logger)
    {
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
        _authenticationService = authenticationService ?? throw new ArgumentNullException(nameof(authenticationService));
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

    /// <summary>
    /// Lists all users with administrator flags (admin JWT role only).
    /// </summary>
    [HttpGet("all")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> ListAllForAdmin(CancellationToken cancellationToken = default)
    {
        var users = await _userRepository.ListAllOrderedByEmailAsync(cancellationToken);
        var result = users.Select(u => new
        {
            id = u.Id,
            email = u.Email,
            name = u.Name,
            isAdmin = u.IsAdmin || AdminEmailBootstrap.IsMatch(_configuration, u.Email),
            isBootstrapAdmin = AdminEmailBootstrap.IsMatch(_configuration, u.Email),
            isAppAdmin = u.IsAdmin
        });
        return Ok(result);
    }

    /// <summary>
    /// Sets the persisted application-admin flag for a user. Bootstrap <c>AdminEmail</c> always receives the admin role regardless of this flag.
    /// </summary>
    [HttpPatch("{id:guid}/admin")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> SetUserAdmin(Guid id, [FromBody] SetUserAdminRequest request, CancellationToken cancellationToken = default)
    {
        var all = await _userRepository.ListAllOrderedByEmailAsync(cancellationToken);
        var user = await _userRepository.GetByIdForUpdateAsync(id, cancellationToken);
        if (user == null)
            return NotFound();

        if (user.IsAdmin == request.IsAdmin)
            return Ok(new { message = "Unchanged" });

        if (!request.IsAdmin)
        {
            var remaining = CountEffectiveAdmins(all, user.Id, newAppAdmin: false);
            if (remaining == 0)
                return BadRequest(new { message = "At least one administrator must remain." });
        }

        user.SetIsAdmin(request.IsAdmin);
        await _userRepository.UpdateAsync(user, cancellationToken);

        var effectiveAdmin = user.IsAdmin || AdminEmailBootstrap.IsMatch(_configuration, user.Email);
        _logger.LogInformation("User {UserId} application admin flag set to {IsAdmin}", id, request.IsAdmin);

        var currentUserId = GetCurrentUserId();
        object? auth = null;
        if (currentUserId == id)
        {
            var token = _authenticationService.GenerateToken(user.Id, user.Email, effectiveAdmin);
            auth = new AuthController.AuthResponse
            {
                Token = token,
                User = new AuthController.UserDto
                {
                    Id = user.Id,
                    Email = user.Email,
                    Name = user.Name,
                    EmailVerified = user.EmailVerified,
                    GitHubUsername = user.GitHubUsername
                }
            };
        }

        return Ok(new { message = "Updated", auth });
    }

    private Guid? GetCurrentUserId()
    {
        var claim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(claim, out var id) ? id : null;
    }

    /// <summary>Count users that would still have the admin role if <paramref name="overrideUserId"/> had <paramref name="newAppAdmin"/> as stored flag.</summary>
    private int CountEffectiveAdmins(IReadOnlyList<User> users, Guid overrideUserId, bool newAppAdmin)
    {
        return users.Count(u =>
        {
            var appAdmin = u.Id == overrideUserId ? newAppAdmin : u.IsAdmin;
            return appAdmin || AdminEmailBootstrap.IsMatch(_configuration, u.Email);
        });
    }

    public class SetUserAdminRequest
    {
        public bool IsAdmin { get; set; }
    }
}
