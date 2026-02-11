namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

/// <summary>
/// Repository interface for Repository entity - defines persistence contract
/// </summary>
public interface IRepositoryRepository
{
    System.Threading.Tasks.Task<Repository?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    /// <summary>Get by id with tracking (for updates).</summary>
    System.Threading.Tasks.Task<Repository?> GetByIdTrackedAsync(Guid id, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<IEnumerable<Repository>> GetByUserIdAsync(Guid userId, CancellationToken cancellationToken = default);

    /// <summary>
    /// Repositories the user can access: owned (UserId) or shared with them.
    /// </summary>
    System.Threading.Tasks.Task<IEnumerable<Repository>> GetAccessibleByUserIdAsync(Guid userId, CancellationToken cancellationToken = default);

    /// <summary>
    /// Get paginated repositories for a user with optional search and filter (owned + shared).
    /// Filter: "all" | "mine" | "shared".
    /// </summary>
    System.Threading.Tasks.Task<(IEnumerable<Repository> Items, int TotalCount)> GetAccessibleByUserIdPaginatedAsync(
        Guid userId,
        string? search = null,
        string? filter = null,
        int page = 1,
        int pageSize = 20,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Get repository by id if the user has access (owner or shared with).
    /// </summary>
    System.Threading.Tasks.Task<Repository?> GetByIdIfAccessibleAsync(Guid id, Guid userId, CancellationToken cancellationToken = default);

    /// <summary>
    /// Get paginated repositories for a user with optional search (owned only).
    /// Search matches Name or FullName (project/organization).
    /// </summary>
    System.Threading.Tasks.Task<(IEnumerable<Repository> Items, int TotalCount)> GetByUserIdPaginatedAsync(
        Guid userId,
        string? search = null,
        int page = 1,
        int pageSize = 20,
        CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<Repository?> GetByFullNameAndProviderAsync(string fullName, string provider, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<Repository?> GetByFullNameProviderAndUserIdAsync(string fullName, string provider, Guid userId, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<Repository> AddAsync(Repository repository, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(Repository repository, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<bool> ExistsAsync(Guid id, CancellationToken cancellationToken = default);
}
