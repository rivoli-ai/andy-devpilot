using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

namespace DevPilot.Infrastructure.Persistence;

public class PostgresCodeAskConversationRepository : ICodeAskConversationRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresCodeAskConversationRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async System.Threading.Tasks.Task<CodeAskConversationSnapshot?> GetAsync(
        Guid userId,
        Guid repositoryId,
        string repoBranchKey,
        CancellationToken cancellationToken = default)
    {
        return await _context.CodeAskConversationSnapshots
            .AsNoTracking()
            .FirstOrDefaultAsync(
                x => x.UserId == userId && x.RepositoryId == repositoryId && x.RepoBranchKey == repoBranchKey,
                cancellationToken);
    }

    public async System.Threading.Tasks.Task UpsertAsync(
        Guid userId,
        Guid repositoryId,
        string repoBranchKey,
        string payloadJson,
        CancellationToken cancellationToken = default)
    {
        var existing = await _context.CodeAskConversationSnapshots
            .FirstOrDefaultAsync(
                x => x.UserId == userId && x.RepositoryId == repositoryId && x.RepoBranchKey == repoBranchKey,
                cancellationToken);

        if (existing is not null)
            existing.ReplacePayload(payloadJson);
        else
            _context.CodeAskConversationSnapshots.Add(
                new CodeAskConversationSnapshot(userId, repositoryId, repoBranchKey, payloadJson));

        await _context.SaveChangesAsync(cancellationToken);
    }
}
