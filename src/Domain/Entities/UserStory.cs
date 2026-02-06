namespace DevPilot.Domain.Entities;

/// <summary>
/// User Story entity representing a requirement from the user's perspective
/// </summary>
public class UserStory : Entity
{
    public string Title { get; private set; }
    public string? Description { get; private set; }
    public Guid FeatureId { get; private set; }
    public string Status { get; private set; } // "Backlog", "InProgress", "Done"
    public string? AcceptanceCriteria { get; private set; }
    public string? PrUrl { get; private set; } // Pull Request URL when implemented
    public int? StoryPoints { get; private set; } // Estimation in story points
    /// <summary>Source: "Manual", "AzureDevOps", "GitHub"</summary>
    public string Source { get; private set; } = "Manual";
    /// <summary>Azure DevOps work item ID when imported from ADO; null for manual/GitHub items</summary>
    public int? AzureDevOpsWorkItemId { get; private set; }

    // Navigation properties
    public Feature Feature { get; private set; } = null!;
    public List<Task> Tasks { get; private set; } = new();

    private UserStory() { }

    public UserStory(
        string title,
        Guid featureId,
        string? description = null,
        string? acceptanceCriteria = null,
        int? storyPoints = null,
        string? source = null,
        int? azureDevOpsWorkItemId = null)
    {
        Title = title ?? throw new ArgumentNullException(nameof(title));
        FeatureId = featureId;
        Description = description;
        AcceptanceCriteria = acceptanceCriteria;
        StoryPoints = storyPoints;
        Status = "Backlog";
        Source = source ?? "Manual";
        AzureDevOpsWorkItemId = azureDevOpsWorkItemId;
    }

    public void SetStoryPoints(int? storyPoints)
    {
        StoryPoints = storyPoints;
        MarkAsUpdated();
    }

    public void UpdateTitle(string title)
    {
        Title = title ?? throw new ArgumentNullException(nameof(title));
        MarkAsUpdated();
    }

    public void UpdateDescription(string? description)
    {
        Description = description;
        MarkAsUpdated();
    }

    public void UpdateAcceptanceCriteria(string? acceptanceCriteria)
    {
        AcceptanceCriteria = acceptanceCriteria;
        MarkAsUpdated();
    }

    public void ChangeStatus(string status, string? prUrl = null)
    {
        if (string.IsNullOrWhiteSpace(status))
            throw new ArgumentException("Status cannot be null or empty", nameof(status));

        Status = status;
        if (prUrl != null)
        {
            PrUrl = prUrl;
        }
        MarkAsUpdated();
    }

    public void SetPrUrl(string? prUrl)
    {
        PrUrl = prUrl;
        MarkAsUpdated();
    }

    public void SetAzureDevOpsWorkItemId(int? id)
    {
        AzureDevOpsWorkItemId = id;
        MarkAsUpdated();
    }
}
