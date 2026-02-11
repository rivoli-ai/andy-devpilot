namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// PostgreSQL implementation of ILinkedProviderRepository
/// </summary>
public class PostgresLinkedProviderRepository : ILinkedProviderRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresLinkedProviderRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async System.Threading.Tasks.Task<LinkedProvider?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.LinkedProviders.FindAsync(new object[] { id }, cancellationToken);
    }

    public async System.Threading.Tasks.Task<LinkedProvider?> GetByUserAndProviderAsync(Guid userId, string provider, CancellationToken cancellationToken = default)
    {
        return await _context.LinkedProviders
            .FirstOrDefaultAsync(lp => lp.UserId == userId && lp.Provider == provider, cancellationToken);
    }

    public async System.Threading.Tasks.Task<LinkedProvider?> GetByProviderUserIdAsync(string provider, string providerUserId, CancellationToken cancellationToken = default)
    {
        return await _context.LinkedProviders
            .FirstOrDefaultAsync(lp => lp.Provider == provider && lp.ProviderUserId == providerUserId, cancellationToken);
    }

    public async System.Threading.Tasks.Task<IEnumerable<LinkedProvider>> GetByUserIdAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        return await _context.LinkedProviders
            .Where(lp => lp.UserId == userId)
            .ToListAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task<LinkedProvider> AddAsync(LinkedProvider linkedProvider, CancellationToken cancellationToken = default)
    {
        await _context.LinkedProviders.AddAsync(linkedProvider, cancellationToken);
        await _context.SaveChangesAsync(cancellationToken);
        return linkedProvider;
    }

    public async System.Threading.Tasks.Task UpdateAsync(LinkedProvider linkedProvider, CancellationToken cancellationToken = default)
    {
        _context.LinkedProviders.Update(linkedProvider);
        await _context.SaveChangesAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default)
    {
        var entity = await _context.LinkedProviders.FindAsync(new object[] { id }, cancellationToken);
        if (entity != null)
        {
            _context.LinkedProviders.Remove(entity);
            await _context.SaveChangesAsync(cancellationToken);
        }
    }
}
