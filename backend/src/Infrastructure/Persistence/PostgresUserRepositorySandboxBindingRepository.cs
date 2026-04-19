namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;
using Task = System.Threading.Tasks.Task;

public class PostgresUserRepositorySandboxBindingRepository : IUserRepositorySandboxBindingRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresUserRepositorySandboxBindingRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async Task<UserRepositorySandboxBinding?> GetByUserAndRepositoryAsync(
        Guid userId,
        Guid repositoryId,
        CancellationToken cancellationToken = default)
    {
        return await _context.UserRepositorySandboxBindings
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.UserId == userId && x.RepositoryId == repositoryId, cancellationToken);
    }

    public async Task UpsertAsync(
        Guid userId,
        Guid repositoryId,
        string sandboxId,
        string repoBranch,
        CancellationToken cancellationToken = default)
    {
        var existing = await _context.UserRepositorySandboxBindings
            .FirstOrDefaultAsync(x => x.UserId == userId && x.RepositoryId == repositoryId, cancellationToken);

        if (existing is not null)
        {
            existing.ReplaceSandbox(sandboxId, repoBranch);
        }
        else
        {
            _context.UserRepositorySandboxBindings.Add(new UserRepositorySandboxBinding(
                userId, repositoryId, sandboxId, repoBranch));
        }

        await _context.SaveChangesAsync(cancellationToken);
    }

    public async Task DeleteBySandboxIdAsync(string sandboxId, CancellationToken cancellationToken = default)
    {
        var rows = await _context.UserRepositorySandboxBindings
            .Where(x => x.SandboxId == sandboxId)
            .ToListAsync(cancellationToken);
        if (rows.Count == 0) return;
        _context.UserRepositorySandboxBindings.RemoveRange(rows);
        await _context.SaveChangesAsync(cancellationToken);
    }
}
