namespace DevPilot.Domain.Interfaces;

public interface IStorySandboxConversationRepository
{
    System.Threading.Tasks.Task UpsertAsync(
        Guid userStoryId,
        string sandboxId,
        string payloadJson,
        System.Threading.CancellationToken cancellationToken = default);

    System.Threading.Tasks.Task<IReadOnlyList<DevPilot.Domain.Entities.StorySandboxConversationSnapshot>> ListByUserStoryIdAsync(
        Guid userStoryId,
        System.Threading.CancellationToken cancellationToken = default);

    System.Threading.Tasks.Task<DevPilot.Domain.Entities.StorySandboxConversationSnapshot?> GetAsync(
        Guid userStoryId,
        string sandboxId,
        System.Threading.CancellationToken cancellationToken = default);
}
