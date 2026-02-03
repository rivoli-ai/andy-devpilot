namespace DevPilot.Domain.Entities;

/// <summary>
/// Feature entity representing a functionality that belongs to an Epic
/// </summary>
public class Feature : Entity
{
    public string Title { get; private set; }
    public string? Description { get; private set; }
    public Guid EpicId { get; private set; }
    public string Status { get; private set; } // "Backlog", "InProgress", "Done"

    // Navigation properties
    public Epic Epic { get; private set; } = null!;
    public List<UserStory> UserStories { get; private set; } = new();

    private Feature() { }

    public Feature(string title, Guid epicId, string? description = null)
    {
        Title = title ?? throw new ArgumentNullException(nameof(title));
        EpicId = epicId;
        Description = description;
        Status = "Backlog";
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
}
