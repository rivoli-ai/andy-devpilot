namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

public class PostgresRepositoryShareRepository : IRepositoryShareRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresRepositoryShareRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async Task<RepositoryShare> AddAsync(RepositoryShare share, CancellationToken cancellationToken = default)
    {
        _context.RepositoryShares.Add(share);
        await _context.SaveChangesAsync(cancellationToken);
        return share;
    }

    public async Task<bool> RemoveAsync(Guid repositoryId, Guid sharedWithUserId, CancellationToken cancellationToken = default)
    {
        var share = await _context.RepositoryShares
            .FirstOrDefaultAsync(s => s.RepositoryId == repositoryId && s.SharedWithUserId == sharedWithUserId, cancellationToken);
        if (share == null) return false;
        _context.RepositoryShares.Remove(share);
        await _context.SaveChangesAsync(cancellationToken);
        return true;
    }

    public async Task<IReadOnlyList<Guid>> GetSharedWithUserIdsAsync(Guid repositoryId, CancellationToken cancellationToken = default)
    {
        return await _context.RepositoryShares
            .AsNoTracking()
            .Where(s => s.RepositoryId == repositoryId)
            .Select(s => s.SharedWithUserId)
            .ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<Guid>> GetRepositoryIdsSharedWithUserAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        return await _context.RepositoryShares
            .AsNoTracking()
            .Where(s => s.SharedWithUserId == userId)
            .Select(s => s.RepositoryId)
            .ToListAsync(cancellationToken);
    }

    public async Task<bool> ExistsAsync(Guid repositoryId, Guid sharedWithUserId, CancellationToken cancellationToken = default)
    {
        return await _context.RepositoryShares
            .AnyAsync(s => s.RepositoryId == repositoryId && s.SharedWithUserId == sharedWithUserId, cancellationToken);
    }

    public async Task<IReadOnlyDictionary<Guid, int>> GetSharedWithCountsByRepositoryIdsAsync(IEnumerable<Guid> repositoryIds, CancellationToken cancellationToken = default)
    {
        var ids = repositoryIds.ToList();
        if (ids.Count == 0) return new Dictionary<Guid, int>();

        var counts = await _context.RepositoryShares
            .AsNoTracking()
            .Where(s => ids.Contains(s.RepositoryId))
            .GroupBy(s => s.RepositoryId)
            .Select(g => new { RepositoryId = g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);

        return counts.ToDictionary(x => x.RepositoryId, x => x.Count);
    }
}
