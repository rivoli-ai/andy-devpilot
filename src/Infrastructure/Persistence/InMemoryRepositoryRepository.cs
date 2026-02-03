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

    public System.Threading.Tasks.Task<Repository?> GetByFullNameAndProviderAsync(string fullName, string provider, CancellationToken cancellationToken = default)
    {
        var repository = _repositories.Values
            .FirstOrDefault(r => r.FullName == fullName && r.Provider == provider);
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

    public System.Threading.Tasks.Task<bool> ExistsAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return System.Threading.Tasks.Task.FromResult(_repositories.ContainsKey(id));
    }
}
