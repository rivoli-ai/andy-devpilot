namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;
using StorySnapshot = DevPilot.Domain.Entities.StorySandboxConversationSnapshot;

public class PostgresStorySandboxConversationRepository : IStorySandboxConversationRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresStorySandboxConversationRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async System.Threading.Tasks.Task UpsertAsync(Guid userStoryId, string sandboxId, string payloadJson, CancellationToken cancellationToken = default)
    {
        var existing = await _context.StorySandboxConversationSnapshots
            .FirstOrDefaultAsync(
                x => x.UserStoryId == userStoryId && x.SandboxId == sandboxId,
                cancellationToken);

        if (existing is not null)
            existing.ReplacePayload(payloadJson);
        else
            _context.StorySandboxConversationSnapshots.Add(new StorySnapshot(userStoryId, sandboxId, payloadJson));

        await _context.SaveChangesAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task<IReadOnlyList<StorySnapshot>> ListByUserStoryIdAsync(
        Guid userStoryId,
        CancellationToken cancellationToken = default)
    {
        return await _context.StorySandboxConversationSnapshots
            .AsNoTracking()
            .Where(x => x.UserStoryId == userStoryId)
            .OrderByDescending(x => x.UpdatedAt ?? x.CreatedAt)
            .ToListAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task<StorySnapshot?> GetAsync(
        Guid userStoryId,
        string sandboxId,
        CancellationToken cancellationToken = default)
    {
        return await _context.StorySandboxConversationSnapshots
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.UserStoryId == userStoryId && x.SandboxId == sandboxId, cancellationToken);
    }
}
