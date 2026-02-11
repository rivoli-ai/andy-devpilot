namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;

/// <summary>
/// In-memory implementation of IEpicRepository for development/testing
/// Will be replaced with EF Core implementation later
/// </summary>
public class InMemoryEpicRepository : IEpicRepository
{
    private readonly Dictionary<Guid, Epic> _epics = new();

    public System.Threading.Tasks.Task<Epic?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        _epics.TryGetValue(id, out var epic);
        return System.Threading.Tasks.Task.FromResult<Epic?>(epic);
    }

    public System.Threading.Tasks.Task<IEnumerable<Epic>> GetByRepositoryIdAsync(Guid repositoryId, CancellationToken cancellationToken = default)
    {
        var epics = _epics.Values
            .Where(e => e.RepositoryId == repositoryId)
            .ToList();

        return System.Threading.Tasks.Task.FromResult<IEnumerable<Epic>>(epics);
    }

    public System.Threading.Tasks.Task<Epic> AddAsync(Epic epic, CancellationToken cancellationToken = default)
    {
        _epics[epic.Id] = epic;
        return System.Threading.Tasks.Task.FromResult(epic);
    }

    public System.Threading.Tasks.Task UpdateAsync(Epic epic, CancellationToken cancellationToken = default)
    {
        if (_epics.ContainsKey(epic.Id))
        {
            _epics[epic.Id] = epic;
        }
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public System.Threading.Tasks.Task DeleteAsync(Epic epic, CancellationToken cancellationToken = default)
    {
        _epics.Remove(epic.Id);
        return System.Threading.Tasks.Task.CompletedTask;
    }
}
