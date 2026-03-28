namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

public interface IArtifactFeedConfigRepository
{
    Task<ArtifactFeedConfig?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<ArtifactFeedConfig>> GetAllAsync(CancellationToken cancellationToken = default);
    Task<IReadOnlyList<ArtifactFeedConfig>> GetEnabledAsync(CancellationToken cancellationToken = default);
    Task<ArtifactFeedConfig> AddAsync(ArtifactFeedConfig entity, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(ArtifactFeedConfig entity, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default);
}
