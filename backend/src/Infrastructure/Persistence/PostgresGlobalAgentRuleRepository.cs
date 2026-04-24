namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

public class PostgresGlobalAgentRuleRepository : IGlobalAgentRuleRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresGlobalAgentRuleRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async System.Threading.Tasks.Task<IReadOnlyList<GlobalAgentRule>> GetAllAsync(CancellationToken cancellationToken = default)
    {
        return await _context.GlobalAgentRules
            .AsNoTracking()
            .OrderBy(r => r.SortOrder)
            .ThenBy(r => r.Name)
            .ToListAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task<GlobalAgentRule?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.GlobalAgentRules
            .AsNoTracking()
            .FirstOrDefaultAsync(r => r.Id == id, cancellationToken);
    }

    public async System.Threading.Tasks.Task<bool> NameExistsAsync(string name, Guid? exceptId, CancellationToken cancellationToken = default)
    {
        var n = (name ?? string.Empty).Trim();
        if (n.Length == 0) return false;
        return await _context.GlobalAgentRules
            .AsNoTracking()
            .AnyAsync(
                r => (exceptId == null || r.Id != exceptId) && r.Name.ToLower() == n.ToLower(),
                cancellationToken);
    }

    public async System.Threading.Tasks.Task<GlobalAgentRule> AddAsync(GlobalAgentRule entity, CancellationToken cancellationToken = default)
    {
        _context.GlobalAgentRules.Add(entity);
        await _context.SaveChangesAsync(cancellationToken);
        return entity;
    }

    public async System.Threading.Tasks.Task UpdateAsync(
        Guid id,
        string name,
        string body,
        int sortOrder,
        CancellationToken cancellationToken = default)
    {
        var tracked = await _context.GlobalAgentRules
            .FirstOrDefaultAsync(r => r.Id == id, cancellationToken);
        if (tracked is null) throw new InvalidOperationException("Global agent rule not found.");
        tracked.Update(name, body, sortOrder);
        await _context.SaveChangesAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default)
    {
        var entity = await _context.GlobalAgentRules
            .FirstOrDefaultAsync(r => r.Id == id, cancellationToken);
        if (entity is null) return;
        _context.GlobalAgentRules.Remove(entity);
        await _context.SaveChangesAsync(cancellationToken);
    }
}
