namespace DevPilot.Application.DTOs;

/// <summary>
/// Data Transfer Object for Task entity
/// </summary>
public class TaskDto
{
    public Guid Id { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public Guid UserStoryId { get; set; }
    public string Status { get; set; } = string.Empty;
    public string Complexity { get; set; } = string.Empty;
    public string? AssignedTo { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? UpdatedAt { get; set; }
}
