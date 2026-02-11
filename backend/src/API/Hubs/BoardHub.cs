namespace DevPilot.API.Hubs;

using Microsoft.AspNetCore.SignalR;

/// <summary>
/// SignalR Hub for real-time board updates
/// Handles board state synchronization across clients
/// </summary>
public class BoardHub : Hub
{
    private readonly ILogger<BoardHub> _logger;

    public BoardHub(ILogger<BoardHub> logger)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Join a board group to receive updates for a specific repository
    /// </summary>
    public async Task JoinBoardGroup(string repositoryId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, $"board-{repositoryId}");
        _logger.LogInformation("Client {ConnectionId} joined board group for repository {RepositoryId}", 
            Context.ConnectionId, repositoryId);
    }

    /// <summary>
    /// Leave a board group
    /// </summary>
    public async Task LeaveBoardGroup(string repositoryId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"board-{repositoryId}");
        _logger.LogInformation("Client {ConnectionId} left board group for repository {RepositoryId}", 
            Context.ConnectionId, repositoryId);
    }

    public override async Task OnConnectedAsync()
    {
        _logger.LogInformation("Client connected: {ConnectionId}", Context.ConnectionId);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        _logger.LogInformation("Client disconnected: {ConnectionId}", Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }
}
