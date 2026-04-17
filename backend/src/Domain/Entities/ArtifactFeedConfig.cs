namespace DevPilot.Domain.Entities;

/// <summary>
/// Azure DevOps Artifacts feed configuration (organization, feed identity, type). Does not store PATs.
/// <see cref="OwnerUserId"/> null = team catalog entry created by admins (what regular users consume). Non-null = legacy/personal row (admins may remove).
/// Supports feed types: "nuget", "npm", "pip".
/// </summary>
public class ArtifactFeedConfig : Entity
{
    public string Name { get; private set; }
    public string Organization { get; private set; }
    public string FeedName { get; private set; }
    public string? ProjectName { get; private set; }
    /// <summary>"nuget", "npm", or "pip"</summary>
    public string FeedType { get; private set; }
    public bool IsEnabled { get; private set; }
    /// <summary>Null = organization-wide shared feed (admin only). Non-null = personal feed.</summary>
    public Guid? OwnerUserId { get; private set; }

    private ArtifactFeedConfig() { }

    public ArtifactFeedConfig(
        string name,
        string organization,
        string feedName,
        string? projectName,
        string feedType,
        bool isEnabled = true,
        Guid? ownerUserId = null)
    {
        Name = name ?? throw new ArgumentNullException(nameof(name));
        Organization = organization ?? throw new ArgumentNullException(nameof(organization));
        FeedName = feedName ?? throw new ArgumentNullException(nameof(feedName));
        ProjectName = projectName;
        FeedType = ValidateFeedType(feedType);
        IsEnabled = isEnabled;
        OwnerUserId = ownerUserId;
    }

    public void Update(
        string? name,
        string? organization,
        string? feedName,
        string? projectName,
        string? feedType)
    {
        if (name != null) Name = name;
        if (organization != null) Organization = organization;
        if (feedName != null) FeedName = feedName;
        if (projectName != null) ProjectName = projectName;
        if (feedType != null) FeedType = ValidateFeedType(feedType);
        MarkAsUpdated();
    }

    public void SetEnabled(bool enabled)
    {
        IsEnabled = enabled;
        MarkAsUpdated();
    }

    private static string ValidateFeedType(string feedType)
    {
        if (feedType is not ("nuget" or "npm" or "pip"))
            throw new ArgumentException("FeedType must be 'nuget', 'npm', or 'pip'.", nameof(feedType));
        return feedType;
    }
}
