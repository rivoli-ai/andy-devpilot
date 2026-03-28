namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

public class PostgresArtifactFeedConfigRepository : IArtifactFeedConfigRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresArtifactFeedConfigRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async Task<ArtifactFeedConfig?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.ArtifactFeedConfigs.FindAsync(new object[] { id }, cancellationToken);
    }

    public async Task<IReadOnlyList<ArtifactFeedConfig>> GetAllAsync(CancellationToken cancellationToken = default)
    {
        return await _context.ArtifactFeedConfigs
            .OrderBy(f => f.Name)
            .ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<ArtifactFeedConfig>> GetEnabledAsync(CancellationToken cancellationToken = default)
    {
        return await _context.ArtifactFeedConfigs
            .Where(f => f.IsEnabled)
            .OrderBy(f => f.Name)
            .ToListAsync(cancellationToken);
    }

    public async Task<ArtifactFeedConfig> AddAsync(ArtifactFeedConfig entity, CancellationToken cancellationToken = default)
    {
        await _context.ArtifactFeedConfigs.AddAsync(entity, cancellationToken).ConfigureAwait(false);
        await _context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return entity;
    }

    public async System.Threading.Tasks.Task UpdateAsync(ArtifactFeedConfig entity, CancellationToken cancellationToken = default)
    {
        _context.ArtifactFeedConfigs.Update(entity);
        await _context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    public async System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default)
    {
        var entity = await _context.ArtifactFeedConfigs.FindAsync(new object[] { id }, cancellationToken);
        if (entity != null)
        {
            _context.ArtifactFeedConfigs.Remove(entity);
            await _context.SaveChangesAsync(cancellationToken);
        }
    }
}
