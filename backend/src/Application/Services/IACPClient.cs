namespace DevPilot.Application.Services;

/// <summary>
/// ACP (Application Control Protocol) client for communicating with Zed IDE containers
/// Uses WebSocket for real-time bidirectional communication
/// </summary>
public interface IACPClient
{
    /// <summary>
    /// Connects to a Zed session via WebSocket
    /// </summary>
    System.Threading.Tasks.Task ConnectAsync(
        string sessionId,
        string endpointUrl,
        string authToken,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Disconnects from the current session
    /// </summary>
    System.Threading.Tasks.Task DisconnectAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Initializes a session in the Zed container
    /// </summary>
    System.Threading.Tasks.Task<ACPResponse> InitSessionAsync(
        string sessionId,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Clones a Git repository into the container workspace
    /// </summary>
    System.Threading.Tasks.Task<ACPResponse> CloneRepositoryAsync(
        string cloneUrl,
        string? branch = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Runs a command in the container and returns the output
    /// </summary>
    System.Threading.Tasks.Task<ACPResponse> RunCommandAsync(
        string command,
        string? workingDirectory = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Analyzes the repository and generates backlog JSON
    /// This is a high-level command that orchestrates multiple steps
    /// </summary>
    System.Threading.Tasks.Task<RepositoryAnalysisResult> AnalyzeRepositoryAsync(
        string repositoryName,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Closes the session and triggers cleanup
    /// </summary>
    System.Threading.Tasks.Task<ACPResponse> CloseSessionAsync(
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Event raised when logs are received from the container
    /// </summary>
    event EventHandler<ACPLogEventArgs>? LogReceived;

    /// <summary>
    /// Indicates if the client is currently connected
    /// </summary>
    bool IsConnected { get; }
}

/// <summary>
/// Response from an ACP command
/// </summary>
public class ACPResponse
{
    public required string CorrelationId { get; set; }
    public required bool Success { get; set; }
    public required string Command { get; set; }
    public string? Data { get; set; }
    public string? Error { get; set; }
    public Dictionary<string, object>? Metadata { get; set; }
}

/// <summary>
/// Event args for log messages from Zed container
/// </summary>
public class ACPLogEventArgs : EventArgs
{
    public required string SessionId { get; set; }
    public required string LogLevel { get; set; } // "info", "warning", "error"
    public required string Message { get; set; }
    public required DateTime Timestamp { get; set; }
}
