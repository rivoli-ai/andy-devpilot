namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// PostgreSQL implementation of IFeatureRepository using EF Core
/// </summary>
public class PostgresFeatureRepository : IFeatureRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresFeatureRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async Task<Feature?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.Features
            .Include(f => f.Epic)
            .FirstOrDefaultAsync(f => f.Id == id, cancellationToken);
    }

    public async Task<Feature> AddAsync(Feature feature, CancellationToken cancellationToken = default)
    {
        _context.Features.Add(feature);
        await _context.SaveChangesAsync(cancellationToken);
        return feature;
    }

    public async System.Threading.Tasks.Task UpdateAsync(Feature feature, CancellationToken cancellationToken = default)
    {
        _context.Features.Update(feature);
        await _context.SaveChangesAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task DeleteAsync(Feature feature, CancellationToken cancellationToken = default)
    {
        var toDelete = await _context.Features.FindAsync(new object[] { feature.Id }, cancellationToken);
        if (toDelete != null)
        {
            _context.Features.Remove(toDelete);
            await _context.SaveChangesAsync(cancellationToken);
        }
    }
}
