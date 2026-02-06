namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

/// <summary>
/// Repository interface for Repository entity - defines persistence contract
/// </summary>
public interface IRepositoryRepository
{
    System.Threading.Tasks.Task<Repository?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<IEnumerable<Repository>> GetByUserIdAsync(Guid userId, CancellationToken cancellationToken = default);

    /// <summary>
    /// Get paginated repositories for a user with optional search.
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
    System.Threading.Tasks.Task<bool> ExistsAsync(Guid id, CancellationToken cancellationToken = default);
}
