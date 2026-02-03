namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// PostgreSQL implementation of IUserStoryRepository using EF Core
/// </summary>
public class PostgresUserStoryRepository : IUserStoryRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresUserStoryRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async Task<UserStory?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.UserStories
            .Include(us => us.Feature)
                .ThenInclude(f => f.Epic)
            .FirstOrDefaultAsync(us => us.Id == id, cancellationToken);
    }

    public async Task<UserStory> AddAsync(UserStory userStory, CancellationToken cancellationToken = default)
    {
        _context.UserStories.Add(userStory);
        await _context.SaveChangesAsync(cancellationToken);
        return userStory;
    }

    public async System.Threading.Tasks.Task UpdateAsync(UserStory userStory, CancellationToken cancellationToken = default)
    {
        _context.UserStories.Update(userStory);
        await _context.SaveChangesAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task DeleteAsync(UserStory userStory, CancellationToken cancellationToken = default)
    {
        var toDelete = await _context.UserStories.FindAsync(new object[] { userStory.Id }, cancellationToken);
        if (toDelete != null)
        {
            _context.UserStories.Remove(toDelete);
            await _context.SaveChangesAsync(cancellationToken);
        }
    }
}
