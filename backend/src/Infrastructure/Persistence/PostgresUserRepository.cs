namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// PostgreSQL implementation of IUserRepository using EF Core
/// </summary>
public class PostgresUserRepository : IUserRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresUserRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async Task<User?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == id, cancellationToken);
    }

    public async Task<User?> GetByIdForUpdateAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.Users
            .FirstOrDefaultAsync(u => u.Id == id, cancellationToken);
    }

    public async Task<IReadOnlyList<User>> ListAllOrderedByEmailAsync(CancellationToken cancellationToken = default)
    {
        return await _context.Users
            .AsNoTracking()
            .OrderBy(u => u.Email)
            .ToListAsync(cancellationToken);
    }

    public async Task<User?> GetByEmailAsync(string email, CancellationToken cancellationToken = default)
    {
        return await _context.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.Email == email, cancellationToken);
    }

    public async Task<IReadOnlyList<User>> SearchSuggestionsAsync(string query, int limit, Guid? excludeUserId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(query) || limit <= 0)
            return Array.Empty<User>();

        var term = query.Trim().ToLower();
        var q = _context.Users.AsNoTracking()
            .Where(u => (u.Email != null && u.Email.ToLower().Contains(term))
                || (u.Name != null && u.Name.ToLower().Contains(term)));
        if (excludeUserId.HasValue)
            q = q.Where(u => u.Id != excludeUserId.Value);
        return await q
            .OrderBy(u => u.Email)
            .Take(limit)
            .ToListAsync(cancellationToken);
    }

    public async Task<User> AddAsync(User user, CancellationToken cancellationToken = default)
    {
        _context.Users.Add(user);
        await _context.SaveChangesAsync(cancellationToken);
        return user;
    }

    public async System.Threading.Tasks.Task UpdateAsync(User user, CancellationToken cancellationToken = default)
    {
        _context.Users.Update(user);
        await _context.SaveChangesAsync(cancellationToken);
    }
}
