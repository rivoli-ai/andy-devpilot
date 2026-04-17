namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

public class PostgresRepositoryAgentRuleRepository : IRepositoryAgentRuleRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresRepositoryAgentRuleRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async System.Threading.Tasks.Task<IReadOnlyList<RepositoryAgentRule>> GetByRepositoryIdAsync(
        Guid repositoryId,
        CancellationToken cancellationToken = default)
    {
        return await _context.RepositoryAgentRules
            .AsNoTracking()
            .Where(r => r.RepositoryId == repositoryId)
            .OrderBy(r => r.SortOrder)
            .ThenBy(r => r.Name)
            .ToListAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task<RepositoryAgentRule?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.RepositoryAgentRules
            .AsNoTracking()
            .FirstOrDefaultAsync(r => r.Id == id, cancellationToken);
    }

    public async System.Threading.Tasks.Task ReplaceForRepositoryAsync(
        Guid repositoryId,
        IReadOnlyList<(Guid? Id, string Name, string Body, bool IsDefault, int SortOrder)> items,
        CancellationToken cancellationToken = default)
    {
        await using var tx = await _context.Database.BeginTransactionAsync(cancellationToken);

        var existing = await _context.RepositoryAgentRules
            .Where(r => r.RepositoryId == repositoryId)
            .ToListAsync(cancellationToken);

        var desiredIds = items.Where(i => i.Id.HasValue).Select(i => i.Id!.Value).ToHashSet();
        foreach (var e in existing.Where(e => !desiredIds.Contains(e.Id)).ToList())
        {
            await _context.Database.ExecuteSqlInterpolatedAsync(
                $"""UPDATE "user_stories" SET "repository_agent_rule_id" = NULL WHERE "repository_agent_rule_id" = {e.Id}""",
                cancellationToken);
            _context.RepositoryAgentRules.Remove(e);
        }

        existing = await _context.RepositoryAgentRules
            .Where(r => r.RepositoryId == repositoryId)
            .ToListAsync(cancellationToken);

        foreach (var row in items)
        {
            if (row.Id.HasValue && existing.Any(x => x.Id == row.Id.Value))
            {
                var entity = existing.First(x => x.Id == row.Id.Value);
                entity.Update(row.Name, row.Body, row.IsDefault, row.SortOrder);
            }
            else
            {
                _context.RepositoryAgentRules.Add(
                    new RepositoryAgentRule(repositoryId, row.Name, row.Body, row.IsDefault, row.SortOrder));
            }
        }

        await _context.SaveChangesAsync(cancellationToken);
        await tx.CommitAsync(cancellationToken);
    }
}
