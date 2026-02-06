namespace DevPilot.Application.DTOs;

/// <summary>
/// Data Transfer Object for UserStory entity
/// </summary>
public class UserStoryDto
{
    public Guid Id { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public Guid FeatureId { get; set; }
    public string Status { get; set; } = string.Empty;
    public string? AcceptanceCriteria { get; set; }
    public string? PrUrl { get; set; } // Pull Request URL when implemented
    public int? StoryPoints { get; set; } // Estimation in story points
    public string Source { get; set; } = "Manual";
    public int? AzureDevOpsWorkItemId { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? UpdatedAt { get; set; }
    public List<TaskDto> Tasks { get; set; } = new();
}
