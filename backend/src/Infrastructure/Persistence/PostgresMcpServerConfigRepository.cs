namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

public class PostgresMcpServerConfigRepository : IMcpServerConfigRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresMcpServerConfigRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async Task<McpServerConfig?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.McpServerConfigs.FindAsync(new object[] { id }, cancellationToken);
    }

    public async Task<IReadOnlyList<McpServerConfig>> GetByUserIdAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        return await _context.McpServerConfigs
            .Where(s => s.UserId == userId)
            .OrderBy(s => s.Name)
            .ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<McpServerConfig>> GetSharedAsync(CancellationToken cancellationToken = default)
    {
        return await _context.McpServerConfigs
            .Where(s => s.UserId == null)
            .OrderBy(s => s.Name)
            .ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<McpServerConfig>> GetEnabledForUserAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        return await _context.McpServerConfigs
            .Where(s => s.IsEnabled && (s.UserId == userId || s.UserId == null))
            .OrderBy(s => s.Name)
            .ToListAsync(cancellationToken);
    }

    public async Task<McpServerConfig> AddAsync(McpServerConfig entity, CancellationToken cancellationToken = default)
    {
        await _context.McpServerConfigs.AddAsync(entity, cancellationToken).ConfigureAwait(false);
        await _context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return entity;
    }

    public async System.Threading.Tasks.Task UpdateAsync(McpServerConfig entity, CancellationToken cancellationToken = default)
    {
        _context.McpServerConfigs.Update(entity);
        await _context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    public async System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default)
    {
        var entity = await _context.McpServerConfigs.FindAsync(new object[] { id }, cancellationToken);
        if (entity != null)
        {
            _context.McpServerConfigs.Remove(entity);
            await _context.SaveChangesAsync(cancellationToken);
        }
    }
}
