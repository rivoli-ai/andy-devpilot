namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

/// <summary>
/// Repository for RepositoryShare - who a repository is shared with.
/// </summary>
public interface IRepositoryShareRepository
{
    Task<RepositoryShare> AddAsync(RepositoryShare share, CancellationToken cancellationToken = default);
    Task<bool> RemoveAsync(Guid repositoryId, Guid sharedWithUserId, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<Guid>> GetSharedWithUserIdsAsync(Guid repositoryId, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<Guid>> GetRepositoryIdsSharedWithUserAsync(Guid userId, CancellationToken cancellationToken = default);
    Task<bool> ExistsAsync(Guid repositoryId, Guid sharedWithUserId, CancellationToken cancellationToken = default);
    /// <summary>Get share counts for multiple repositories (e.g. for list views).</summary>
    Task<IReadOnlyDictionary<Guid, int>> GetSharedWithCountsByRepositoryIdsAsync(IEnumerable<Guid> repositoryIds, CancellationToken cancellationToken = default);
}
