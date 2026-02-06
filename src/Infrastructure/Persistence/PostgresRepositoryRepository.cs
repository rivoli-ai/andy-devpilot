namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// PostgreSQL implementation of IRepositoryRepository using EF Core
/// </summary>
public class PostgresRepositoryRepository : IRepositoryRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresRepositoryRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async Task<Repository?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.Repositories
            .AsNoTracking()
            .Include(r => r.Epics)
                .ThenInclude(e => e.Features)
                    .ThenInclude(f => f.UserStories)
                        .ThenInclude(us => us.Tasks)
            .FirstOrDefaultAsync(r => r.Id == id, cancellationToken);
    }

    public async Task<IEnumerable<Repository>> GetByUserIdAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        return await _context.Repositories
            .AsNoTracking()
            .Include(r => r.Epics)
                .ThenInclude(e => e.Features)
                    .ThenInclude(f => f.UserStories)
                        .ThenInclude(us => us.Tasks)
            .Where(r => r.UserId == userId)
            .ToListAsync(cancellationToken);
    }

    public async Task<(IEnumerable<Repository> Items, int TotalCount)> GetByUserIdPaginatedAsync(
        Guid userId,
        string? search = null,
        int page = 1,
        int pageSize = 20,
        CancellationToken cancellationToken = default)
    {
        var query = _context.Repositories
            .AsNoTracking()
            .Where(r => r.UserId == userId);

        if (!string.IsNullOrWhiteSpace(search))
        {
            var term = search.Trim().ToLower();
            query = query.Where(r =>
                r.Name.ToLower().Contains(term) ||
                r.FullName.ToLower().Contains(term) ||
                (r.OrganizationName != null && r.OrganizationName.ToLower().Contains(term)));
        }

        var totalCount = await query.CountAsync(cancellationToken);

        var items = await query
            .OrderBy(r => r.FullName)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(cancellationToken);

        return (items, totalCount);
    }

    public async Task<Repository?> GetByFullNameAndProviderAsync(string fullName, string provider, CancellationToken cancellationToken = default)
    {
        return await _context.Repositories
            .AsNoTracking()
            .FirstOrDefaultAsync(r => r.FullName == fullName && r.Provider == provider, cancellationToken);
    }

    public async Task<Repository?> GetByFullNameProviderAndUserIdAsync(string fullName, string provider, Guid userId, CancellationToken cancellationToken = default)
    {
        return await _context.Repositories
            .AsNoTracking()
            .FirstOrDefaultAsync(r => r.FullName == fullName && r.Provider == provider && r.UserId == userId, cancellationToken);
    }

    public async Task<Repository> AddAsync(Repository repository, CancellationToken cancellationToken = default)
    {
        _context.Repositories.Add(repository);
        await _context.SaveChangesAsync(cancellationToken);
        return repository;
    }

    public async System.Threading.Tasks.Task UpdateAsync(Repository repository, CancellationToken cancellationToken = default)
    {
        _context.Repositories.Update(repository);
        await _context.SaveChangesAsync(cancellationToken);
    }

    public async Task<bool> ExistsAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.Repositories.AnyAsync(r => r.Id == id, cancellationToken);
    }
}
