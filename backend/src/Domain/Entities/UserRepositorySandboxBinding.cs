namespace DevPilot.Domain.Entities;

/// <summary>
/// Tracks the active DevPilot sandbox container for Code Ask, per user, repository, and branch.
/// Used to reconnect after refresh without client-side storage.
/// </summary>
public class UserRepositorySandboxBinding : Entity
{
    public Guid UserId { get; private set; }
    public Guid RepositoryId { get; private set; }
    /// <summary>Container id from the VPS sandbox manager.</summary>
    public string SandboxId { get; private set; } = string.Empty;
    /// <summary>Git branch this sandbox is bound to (separate row per branch for the same repository).</summary>
    public string RepoBranch { get; private set; } = "main";

    private UserRepositorySandboxBinding()
    {
    }

    public UserRepositorySandboxBinding(Guid userId, Guid repositoryId, string sandboxId, string repoBranch)
    {
        UserId = userId;
        RepositoryId = repositoryId;
        SandboxId = sandboxId ?? throw new ArgumentNullException(nameof(sandboxId));
        RepoBranch = string.IsNullOrWhiteSpace(repoBranch) ? "main" : repoBranch.Trim();
    }

    public void ReplaceSandbox(string sandboxId, string repoBranch)
    {
        SandboxId = sandboxId ?? throw new ArgumentNullException(nameof(sandboxId));
        RepoBranch = string.IsNullOrWhiteSpace(repoBranch) ? "main" : repoBranch.Trim();
        MarkAsUpdated();
    }
}
