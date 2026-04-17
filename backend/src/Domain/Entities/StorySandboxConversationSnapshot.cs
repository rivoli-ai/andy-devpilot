namespace DevPilot.Domain.Entities;

/// <summary>
/// Latest bridge <c>/all-conversations</c> JSON for one user story and one sandbox run.
/// Upserted by the API proxy while the sandbox is active so history survives container restarts.
/// </summary>
public class StorySandboxConversationSnapshot : Entity
{
    public Guid UserStoryId { get; private set; }
    /// <summary>DevPilot sandbox container id (UUID string).</summary>
    public string SandboxId { get; private set; } = string.Empty;
    /// <summary>Full JSON body from the sandbox bridge (conversations, count, flags).</summary>
    public string PayloadJson { get; private set; } = string.Empty;

    private StorySandboxConversationSnapshot()
    {
    }

    public StorySandboxConversationSnapshot(Guid userStoryId, string sandboxId, string payloadJson)
    {
        UserStoryId = userStoryId;
        SandboxId = sandboxId ?? throw new ArgumentNullException(nameof(sandboxId));
        PayloadJson = payloadJson ?? throw new ArgumentNullException(nameof(payloadJson));
    }

    public void ReplacePayload(string payloadJson)
    {
        PayloadJson = payloadJson ?? throw new ArgumentNullException(nameof(payloadJson));
        MarkAsUpdated();
    }
}
