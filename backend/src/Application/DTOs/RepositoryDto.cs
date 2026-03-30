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
    /// <summary>True if the current user owns this repository; false if it is shared with them.</summary>
    public bool IsOwner { get; set; }
    /// <summary>Number of users this repo is shared with (only set for owned repos).</summary>
    public int SharedWithCount { get; set; }
    /// <summary>When shared with you: name of the person who shared it (repo owner).</summary>
    public string? OwnerName { get; set; }
    /// <summary>When shared with you: email of the person who shared it (repo owner).</summary>
    public string? OwnerEmail { get; set; }
    /// <summary>LLM setting ID for this repo (null = use user default).</summary>
    public Guid? LlmSettingId { get; set; }
    /// <summary>Display name of the selected LLM (e.g. "OpenAI GPT-4") when set.</summary>
    public string? LlmSettingName { get; set; }
    /// <summary>Custom AI agent rules for this repo. Null = use default template.</summary>
    public string? AgentRules { get; set; }
    /// <summary>Azure Service Principal client ID (non-sensitive). Null when not configured.</summary>
    public string? AzureIdentityClientId { get; set; }
    /// <summary>Azure AD tenant ID (non-sensitive). Null when not configured.</summary>
    public string? AzureIdentityTenantId { get; set; }
    /// <summary>True when an Azure Service Principal identity is fully configured.</summary>
    public bool HasAzureIdentity { get; set; }
}
