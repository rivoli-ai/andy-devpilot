namespace DevPilot.Domain.Entities;

/// <summary>
/// Task entity representing a work item that belongs to a User Story
/// </summary>
public class Task : Entity
{
    public string Title { get; private set; }
    public string? Description { get; private set; }
    public Guid UserStoryId { get; private set; }
    public string Status { get; private set; } // "Backlog", "InProgress", "Done"
    public string Complexity { get; private set; } // "Simple", "Medium", "Complex"
    public string? AssignedTo { get; private set; }

    // Navigation properties
    public UserStory UserStory { get; private set; } = null!;

    private Task() { }

    public Task(
        string title,
        Guid userStoryId,
        string complexity = "Medium",
        string? description = null)
    {
        Title = title ?? throw new ArgumentNullException(nameof(title));
        UserStoryId = userStoryId;
        Complexity = complexity ?? throw new ArgumentNullException(nameof(complexity));
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

    public void ChangeComplexity(string complexity)
    {
        if (string.IsNullOrWhiteSpace(complexity))
            throw new ArgumentException("Complexity cannot be null or empty", nameof(complexity));

        Complexity = complexity;
        MarkAsUpdated();
    }

    public void AssignTo(string? assignedTo)
    {
        AssignedTo = assignedTo;
        MarkAsUpdated();
    }
}
