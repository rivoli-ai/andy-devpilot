namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

public interface IMcpServerConfigRepository
{
    Task<McpServerConfig?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<McpServerConfig>> GetByUserIdAsync(Guid userId, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<McpServerConfig>> GetSharedAsync(CancellationToken cancellationToken = default);
    /// <summary>Returns all enabled MCP servers for a user (personal + shared).</summary>
    Task<IReadOnlyList<McpServerConfig>> GetEnabledForUserAsync(Guid userId, CancellationToken cancellationToken = default);
    Task<McpServerConfig> AddAsync(McpServerConfig entity, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(McpServerConfig entity, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default);
}
