namespace DevPilot.Domain.Entities;

/// <summary>
/// Represents a repository shared with another user. Owner is Repository.UserId; this entity grants access to additional users.
/// </summary>
public class RepositoryShare : Entity
{
    public Guid RepositoryId { get; private set; }
    public Guid SharedWithUserId { get; private set; }

    private RepositoryShare() { }

    public RepositoryShare(Guid repositoryId, Guid sharedWithUserId)
    {
        RepositoryId = repositoryId;
        SharedWithUserId = sharedWithUserId;
    }
}
