namespace DevPilot.Infrastructure.Persistence;

using System.Threading.Tasks;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;

public class InMemoryRepositoryShareRepository : IRepositoryShareRepository
{
    private static readonly List<RepositoryShare> _shares = new();

    public Task<RepositoryShare> AddAsync(RepositoryShare share, CancellationToken cancellationToken = default)
    {
        _shares.Add(share);
        return System.Threading.Tasks.Task.FromResult(share);
    }

    public Task<bool> RemoveAsync(Guid repositoryId, Guid sharedWithUserId, CancellationToken cancellationToken = default)
    {
        var removed = _shares.RemoveAll(s => s.RepositoryId == repositoryId && s.SharedWithUserId == sharedWithUserId);
        return System.Threading.Tasks.Task.FromResult(removed > 0);
    }

    public Task<IReadOnlyList<Guid>> GetSharedWithUserIdsAsync(Guid repositoryId, CancellationToken cancellationToken = default)
    {
        var ids = _shares.Where(s => s.RepositoryId == repositoryId).Select(s => s.SharedWithUserId).ToList();
        return System.Threading.Tasks.Task.FromResult<IReadOnlyList<Guid>>(ids);
    }

    public Task<IReadOnlyList<Guid>> GetRepositoryIdsSharedWithUserAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        var ids = _shares.Where(s => s.SharedWithUserId == userId).Select(s => s.RepositoryId).ToList();
        return System.Threading.Tasks.Task.FromResult<IReadOnlyList<Guid>>(ids);
    }

    public Task<bool> ExistsAsync(Guid repositoryId, Guid sharedWithUserId, CancellationToken cancellationToken = default)
    {
        var exists = _shares.Any(s => s.RepositoryId == repositoryId && s.SharedWithUserId == sharedWithUserId);
        return System.Threading.Tasks.Task.FromResult(exists);
    }

    public Task<IReadOnlyDictionary<Guid, int>> GetSharedWithCountsByRepositoryIdsAsync(IEnumerable<Guid> repositoryIds, CancellationToken cancellationToken = default)
    {
        var ids = repositoryIds.ToHashSet();
        var counts = _shares
            .Where(s => ids.Contains(s.RepositoryId))
            .GroupBy(s => s.RepositoryId)
            .ToDictionary(g => g.Key, g => g.Count());
        return System.Threading.Tasks.Task.FromResult<IReadOnlyDictionary<Guid, int>>(counts);
    }
}
