namespace DevPilot.Domain.Entities;

/// <summary>
/// Epic entity representing a large body of work that contains multiple features
/// </summary>
public class Epic : Entity
{
    public string Title { get; private set; }
    public string? Description { get; private set; }
    public Guid RepositoryId { get; private set; }
    public string Status { get; private set; } // "Backlog", "InProgress", "Done"
    /// <summary>Source: "Manual", "AzureDevOps", "GitHub"</summary>
    public string Source { get; private set; } = "Manual";
    /// <summary>Azure DevOps work item ID when imported from ADO; null for manual/GitHub items</summary>
    public int? AzureDevOpsWorkItemId { get; private set; }

    // Navigation properties
    public Repository Repository { get; private set; } = null!;
    public List<Feature> Features { get; private set; } = new();

    private Epic() { }

    public Epic(string title, Guid repositoryId, string? description = null, string? source = null, int? azureDevOpsWorkItemId = null)
    {
        Title = title ?? throw new ArgumentNullException(nameof(title));
        RepositoryId = repositoryId;
        Description = description;
        Status = "Backlog";
        Source = source ?? "Manual";
        AzureDevOpsWorkItemId = azureDevOpsWorkItemId;
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

    public void ChangeStatus(string status)
    {
        if (string.IsNullOrWhiteSpace(status))
            throw new ArgumentException("Status cannot be null or empty", nameof(status));

        Status = status;
        MarkAsUpdated();
    }

    public void SetAzureDevOpsWorkItemId(int? id)
    {
        AzureDevOpsWorkItemId = id;
        MarkAsUpdated();
    }
}
