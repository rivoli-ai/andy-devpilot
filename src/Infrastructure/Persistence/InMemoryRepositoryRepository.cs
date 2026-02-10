namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;

/// <summary>
/// In-memory implementation of IRepositoryRepository for development/testing
/// Will be replaced with EF Core implementation later
/// </summary>
public class InMemoryRepositoryRepository : IRepositoryRepository
{
    private readonly Dictionary<Guid, Repository> _repositories = new();
    private readonly IRepositoryShareRepository? _shareRepository;

    public InMemoryRepositoryRepository(IRepositoryShareRepository? shareRepository = null)
    {
        _shareRepository = shareRepository;
    }

    public System.Threading.Tasks.Task<Repository?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        _repositories.TryGetValue(id, out var repository);
        return System.Threading.Tasks.Task.FromResult<Repository?>(repository);
    }

    public System.Threading.Tasks.Task<IEnumerable<Repository>> GetByUserIdAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        var repositories = _repositories.Values
            .Where(r => r.UserId == userId)
            .ToList();

        return System.Threading.Tasks.Task.FromResult<IEnumerable<Repository>>(repositories);
    }

    public async System.Threading.Tasks.Task<IEnumerable<Repository>> GetAccessibleByUserIdAsync(Guid userId, System.Threading.CancellationToken cancellationToken = default)
    {
        var sharedIds = _shareRepository != null
            ? await _shareRepository.GetRepositoryIdsSharedWithUserAsync(userId, cancellationToken)
            : Array.Empty<Guid>();
        var set = sharedIds.ToHashSet();
        var list = _repositories.Values
            .Where(r => r.UserId == userId || set.Contains(r.Id))
            .ToList();
        return list;
    }

    public async System.Threading.Tasks.Task<(IEnumerable<Repository> Items, int TotalCount)> GetAccessibleByUserIdPaginatedAsync(
        Guid userId,
        string? search = null,
        string? filter = null,
        int page = 1,
        int pageSize = 20,
        System.Threading.CancellationToken cancellationToken = default)
    {
        var sharedIds = _shareRepository != null
            ? await _shareRepository.GetRepositoryIdsSharedWithUserAsync(userId, cancellationToken)
            : Array.Empty<Guid>();
        var set = sharedIds.ToHashSet();
        var filtered = _repositories.Values
            .Where(r => r.UserId == userId || set.Contains(r.Id));

        if (string.Equals(filter, "mine", StringComparison.OrdinalIgnoreCase))
            filtered = filtered.Where(r => r.UserId == userId);
        else if (string.Equals(filter, "shared", StringComparison.OrdinalIgnoreCase))
            filtered = filtered.Where(r => r.UserId != userId);

        if (!string.IsNullOrWhiteSpace(search))
        {
            var term = search.Trim().ToLowerInvariant();
            filtered = filtered.Where(r =>
                r.Name.ToLowerInvariant().Contains(term) ||
                r.FullName.ToLowerInvariant().Contains(term) ||
                (r.OrganizationName != null && r.OrganizationName.ToLowerInvariant().Contains(term)));
        }

        var totalCount = filtered.Count();
        var items = filtered
            .OrderBy(r => r.FullName)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToList();

        return (items, totalCount);
    }

    public async System.Threading.Tasks.Task<Repository?> GetByIdIfAccessibleAsync(Guid id, Guid userId, System.Threading.CancellationToken cancellationToken = default)
    {
        if (!_repositories.TryGetValue(id, out var repo)) return null;
        if (repo.UserId == userId) return repo;
        if (_shareRepository != null && await _shareRepository.ExistsAsync(id, userId, cancellationToken))
            return repo;
        return null;
    }

    public System.Threading.Tasks.Task<(IEnumerable<Repository> Items, int TotalCount)> GetByUserIdPaginatedAsync(
        Guid userId,
        string? search = null,
        int page = 1,
        int pageSize = 20,
        CancellationToken cancellationToken = default)
    {
        var filtered = _repositories.Values
            .Where(r => r.UserId == userId);

        if (!string.IsNullOrWhiteSpace(search))
        {
            var term = search.Trim().ToLowerInvariant();
            filtered = filtered.Where(r =>
                r.Name.ToLowerInvariant().Contains(term) ||
                r.FullName.ToLowerInvariant().Contains(term) ||
                (r.OrganizationName != null && r.OrganizationName.ToLowerInvariant().Contains(term)));
        }

        var totalCount = filtered.Count();
        var items = filtered
            .OrderBy(r => r.FullName)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToList();

        return System.Threading.Tasks.Task.FromResult<(IEnumerable<Repository> Items, int TotalCount)>((items, totalCount));
    }

    public System.Threading.Tasks.Task<Repository?> GetByFullNameAndProviderAsync(string fullName, string provider, CancellationToken cancellationToken = default)
    {
        var repository = _repositories.Values
            .FirstOrDefault(r => r.FullName == fullName && r.Provider == provider);
        return System.Threading.Tasks.Task.FromResult<Repository?>(repository);
    }

    public System.Threading.Tasks.Task<Repository?> GetByFullNameProviderAndUserIdAsync(string fullName, string provider, Guid userId, CancellationToken cancellationToken = default)
    {
        var repository = _repositories.Values
            .FirstOrDefault(r => r.FullName == fullName && r.Provider == provider && r.UserId == userId);
        return System.Threading.Tasks.Task.FromResult<Repository?>(repository);
    }

    public System.Threading.Tasks.Task<Repository> AddAsync(Repository repository, CancellationToken cancellationToken = default)
    {
        _repositories[repository.Id] = repository;
        return System.Threading.Tasks.Task.FromResult(repository);
    }

    public System.Threading.Tasks.Task UpdateAsync(Repository repository, CancellationToken cancellationToken = default)
    {
        if (_repositories.ContainsKey(repository.Id))
        {
            _repositories[repository.Id] = repository;
        }
        return System.Threading.Tasks.Task.CompletedTask;
    }


    public System.Threading.Tasks.Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken = default)
    {
        var removed = _repositories.Remove(id);
        return System.Threading.Tasks.Task.FromResult(removed);
    }

    public System.Threading.Tasks.Task<bool> ExistsAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return System.Threading.Tasks.Task.FromResult(_repositories.ContainsKey(id));
    }
}
