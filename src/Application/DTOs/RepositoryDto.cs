namespace DevPilot.Application.DTOs;

/// <summary>
/// Data Transfer Object for Repository entity
/// </summary>
public class RepositoryDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string FullName { get; set; } = string.Empty;
    public string CloneUrl { get; set; } = string.Empty;
    public string? Description { get; set; }
    public bool IsPrivate { get; set; }
    public string Provider { get; set; } = string.Empty;
    public string OrganizationName { get; set; } = string.Empty;
    public string? DefaultBranch { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? UpdatedAt { get; set; }
}
