namespace DevPilot.Infrastructure.Persistence;

using System.Collections.Generic;
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

    public async Task<IReadOnlyList<UserRepositorySandboxBinding>> GetAllByUserIdAsync(
        Guid userId,
        CancellationToken cancellationToken = default)
    {
        return await _context.UserRepositorySandboxBindings
            .AsNoTracking()
            .Where(x => x.UserId == userId)
            .OrderBy(x => x.RepositoryId)
            .ThenBy(x => x.RepoBranch)
            .ToListAsync(cancellationToken);
    }

    public async Task<UserRepositorySandboxBinding?> GetByUserRepositoryAndBranchAsync(
        Guid userId,
        Guid repositoryId,
        string repoBranch,
        CancellationToken cancellationToken = default)
    {
        var key = NormalizeBranchKey(repoBranch);
        return await _context.UserRepositorySandboxBindings
            .AsNoTracking()
            .FirstOrDefaultAsync(
                x => x.UserId == userId && x.RepositoryId == repositoryId && x.RepoBranch == key,
                cancellationToken);
    }

    public async Task UpsertAsync(
        Guid userId,
        Guid repositoryId,
        string sandboxId,
        string repoBranch,
        CancellationToken cancellationToken = default)
    {
        var key = NormalizeBranchKey(repoBranch);
        var existing = await _context.UserRepositorySandboxBindings
            .FirstOrDefaultAsync(
                x => x.UserId == userId && x.RepositoryId == repositoryId && x.RepoBranch == key,
                cancellationToken);

        if (existing is not null)
        {
            existing.ReplaceSandbox(sandboxId, key);
        }
        else
        {
            _context.UserRepositorySandboxBindings.Add(new UserRepositorySandboxBinding(
                userId, repositoryId, sandboxId, key));
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

    private static string NormalizeBranchKey(string? repoBranch) =>
        string.IsNullOrWhiteSpace(repoBranch) ? "main" : repoBranch.Trim();
}
