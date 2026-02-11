namespace DevPilot.Application.DTOs;

/// <summary>
/// Data Transfer Object for Epic entity
/// </summary>
public class EpicDto
{
    public Guid Id { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public Guid RepositoryId { get; set; }
    public string Status { get; set; } = string.Empty;
    public string Source { get; set; } = "Manual";
    public int? AzureDevOpsWorkItemId { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? UpdatedAt { get; set; }
    public List<FeatureDto> Features { get; set; } = new();
}
