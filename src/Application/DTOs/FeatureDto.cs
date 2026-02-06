namespace DevPilot.Application.DTOs;

/// <summary>
/// Data Transfer Object for Feature entity
/// </summary>
public class FeatureDto
{
    public Guid Id { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public Guid EpicId { get; set; }
    public string Status { get; set; } = string.Empty;
    public string Source { get; set; } = "Manual";
    public int? AzureDevOpsWorkItemId { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? UpdatedAt { get; set; }
    public List<UserStoryDto> UserStories { get; set; } = new();
}
