using DevPilot.Domain.Entities;

namespace DevPilot.Domain.Interfaces;

public interface ICodeAskConversationRepository
{
    System.Threading.Tasks.Task<CodeAskConversationSnapshot?> GetAsync(
        Guid userId,
        Guid repositoryId,
        string repoBranchKey,
        CancellationToken cancellationToken = default);

    System.Threading.Tasks.Task UpsertAsync(
        Guid userId,
        Guid repositoryId,
        string repoBranchKey,
        string payloadJson,
        CancellationToken cancellationToken = default);
}
