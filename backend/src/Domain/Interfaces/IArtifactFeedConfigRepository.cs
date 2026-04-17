namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

public interface IArtifactFeedConfigRepository
{
    Task<ArtifactFeedConfig?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<ArtifactFeedConfig>> GetAllAsync(CancellationToken cancellationToken = default);
    /// <summary>Feeds visible in Settings: all rows for admins; shared catalog (<c>OwnerUserId</c> null) only for non-admins.</summary>
    Task<IReadOnlyList<ArtifactFeedConfig>> GetAllVisibleAsync(Guid currentUserId, bool isAdmin, CancellationToken cancellationToken = default);
    /// <summary>Enabled admin-defined shared feeds (used for sandboxes; users authenticate with their own PAT).</summary>
    Task<IReadOnlyList<ArtifactFeedConfig>> GetEnabledSharedAsync(CancellationToken cancellationToken = default);
    Task<ArtifactFeedConfig> AddAsync(ArtifactFeedConfig entity, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(ArtifactFeedConfig entity, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default);
}
