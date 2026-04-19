namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

/// <summary>
/// Repository interface for Epic entity
/// </summary>
public interface IEpicRepository
{
    System.Threading.Tasks.Task<Epic?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<IEnumerable<Epic>> GetByRepositoryIdAsync(Guid repositoryId, CancellationToken cancellationToken = default);
    /// <summary>Removes all epics (and cascaded features, stories, tasks) for a repository.</summary>
    System.Threading.Tasks.Task DeleteAllForRepositoryAsync(Guid repositoryId, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<Epic> AddAsync(Epic epic, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(Epic epic, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteAsync(Epic epic, CancellationToken cancellationToken = default);
}
