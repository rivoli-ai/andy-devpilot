namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

/// <summary>
/// Repository interface for LinkedProvider entity
/// </summary>
public interface ILinkedProviderRepository
{
    System.Threading.Tasks.Task<LinkedProvider?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<LinkedProvider?> GetByUserAndProviderAsync(Guid userId, string provider, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<LinkedProvider?> GetByProviderUserIdAsync(string provider, string providerUserId, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<IEnumerable<LinkedProvider>> GetByUserIdAsync(Guid userId, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<LinkedProvider> AddAsync(LinkedProvider linkedProvider, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(LinkedProvider linkedProvider, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default);
}
