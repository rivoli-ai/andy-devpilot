namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// PostgreSQL implementation of IEpicRepository using EF Core
/// </summary>
public class PostgresEpicRepository : IEpicRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresEpicRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async Task<Epic?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.Epics
            .AsNoTracking()
            .Include(e => e.Features)
                .ThenInclude(f => f.UserStories)
                    .ThenInclude(us => us.Tasks)
            .FirstOrDefaultAsync(e => e.Id == id, cancellationToken);
    }

    public async Task<IEnumerable<Epic>> GetByRepositoryIdAsync(Guid repositoryId, CancellationToken cancellationToken = default)
    {
        return await _context.Epics
            .AsNoTracking()
            .Include(e => e.Features)
                .ThenInclude(f => f.UserStories)
                    .ThenInclude(us => us.Tasks)
            .Where(e => e.RepositoryId == repositoryId)
            .ToListAsync(cancellationToken);
    }

    public async Task<Epic> AddAsync(Epic epic, CancellationToken cancellationToken = default)
    {
        _context.Epics.Add(epic);
        await _context.SaveChangesAsync(cancellationToken);
        return epic;
    }

    public async System.Threading.Tasks.Task UpdateAsync(Epic epic, CancellationToken cancellationToken = default)
    {
        _context.Epics.Update(epic);
        await _context.SaveChangesAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task DeleteAsync(Epic epic, CancellationToken cancellationToken = default)
    {
        var toDelete = await _context.Epics.FindAsync(new object[] { epic.Id }, cancellationToken);
        if (toDelete != null)
        {
            _context.Epics.Remove(toDelete);
            await _context.SaveChangesAsync(cancellationToken);
        }
    }
}
