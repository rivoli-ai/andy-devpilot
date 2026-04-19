namespace DevPilot.Domain.Entities;

/// <summary>
/// Persisted Code Ask thread for one user, repository, and branch (server-side; survives refresh and bridge quirks).
/// </summary>
public class CodeAskConversationSnapshot : Entity
{
    public Guid UserId { get; private set; }
    public Guid RepositoryId { get; private set; }
    /// <summary>Normalized branch key (trimmed, lower-invariant) for uniqueness.</summary>
    public string RepoBranchKey { get; private set; } = string.Empty;
    /// <summary>JSON array of messages (id, role, content, toolCallsSummary).</summary>
    public string PayloadJson { get; private set; } = string.Empty;

    private CodeAskConversationSnapshot()
    {
    }

    public CodeAskConversationSnapshot(Guid userId, Guid repositoryId, string repoBranchKey, string payloadJson)
    {
        UserId = userId;
        RepositoryId = repositoryId;
        RepoBranchKey = repoBranchKey ?? throw new ArgumentNullException(nameof(repoBranchKey));
        PayloadJson = payloadJson ?? throw new ArgumentNullException(nameof(payloadJson));
    }

    public void ReplacePayload(string payloadJson)
    {
        PayloadJson = payloadJson ?? throw new ArgumentNullException(nameof(payloadJson));
        MarkAsUpdated();
    }
}
