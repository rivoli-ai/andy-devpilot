namespace DevPilot.Application.Services;

/// <summary>
/// Service interface for managing Zed IDE sessions on VPS infrastructure
/// Handles container lifecycle, session creation, and cleanup
/// </summary>
public interface IZedSessionService
{
    /// <summary>
    /// Creates a new Zed session container on the VPS
    /// Returns session details including endpoint URL and authentication token
    /// </summary>
    System.Threading.Tasks.Task<ZedSessionInfo> CreateSessionAsync(
        Guid userId,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Destroys a Zed session container and cleans up resources
    /// </summary>
    System.Threading.Tasks.Task DestroySessionAsync(
        string sessionId,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Gets the status of a Zed session
    /// </summary>
    System.Threading.Tasks.Task<ZedSessionStatus> GetSessionStatusAsync(
        string sessionId,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Information about a Zed session including endpoint and authentication
/// </summary>
public class ZedSessionInfo
{
    public required string SessionId { get; set; }
    public required string EndpointUrl { get; set; }
    public required string AuthToken { get; set; }
    public required DateTime CreatedAt { get; set; }
    public required DateTime ExpiresAt { get; set; }
}

/// <summary>
/// Status of a Zed session
/// </summary>
public class ZedSessionStatus
{
    public required string SessionId { get; set; }
    public required string Status { get; set; } // "creating", "ready", "active", "completed", "failed"
    public required DateTime CreatedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public string? ErrorMessage { get; set; }
}
