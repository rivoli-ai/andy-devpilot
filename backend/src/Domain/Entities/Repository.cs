namespace DevPilot.Domain.Entities;

/// <summary>
/// Repository entity representing a Git repository from GitHub or Azure DevOps
/// </summary>
public class Repository : Entity
{
    public string Name { get; private set; }
    public string FullName { get; private set; }
    public string CloneUrl { get; private set; }
    public string? Description { get; private set; }
    public bool IsPrivate { get; private set; }
    public string Provider { get; private set; } // "GitHub" or "AzureDevOps"
    public string OrganizationName { get; private set; }
    public Guid UserId { get; private set; }
    public string? DefaultBranch { get; private set; }
    /// <summary>When set, this repo uses this LLM instead of the user's default. Null = use default.</summary>
    public Guid? LlmSettingId { get; private set; }
    /// <summary>Custom AI agent rules for this repo. Null = use default template.</summary>
    public string? AgentRules { get; private set; }

    /// <summary>Azure Service Principal client ID for sandbox authentication (Key Vault, etc.).</summary>
    public string? AzureIdentityClientId { get; private set; }
    /// <summary>Azure Service Principal client secret. Never exposed via DTOs.</summary>
    public string? AzureIdentityClientSecret { get; private set; }
    /// <summary>Azure AD tenant ID for the Service Principal.</summary>
    public string? AzureIdentityTenantId { get; private set; }

    // Navigation properties
    public List<Epic> Epics { get; private set; } = new();
    public List<RepositoryAgentRule> RepositoryAgentRules { get; private set; } = new();

    private Repository() { }

    public Repository(
        string name,
        string fullName,
        string cloneUrl,
        string provider,
        string organizationName,
        Guid userId,
        string? description = null,
        bool isPrivate = false,
        string? defaultBranch = null)
    {
        Name = name ?? throw new ArgumentNullException(nameof(name));
        FullName = fullName ?? throw new ArgumentNullException(nameof(fullName));
        CloneUrl = cloneUrl ?? throw new ArgumentNullException(nameof(cloneUrl));
        Provider = provider ?? throw new ArgumentNullException(nameof(provider));
        OrganizationName = organizationName ?? throw new ArgumentNullException(nameof(organizationName));
        UserId = userId;
        Description = description;
        IsPrivate = isPrivate;
        DefaultBranch = defaultBranch;
    }

    public void UpdateDescription(string? description)
    {
        Description = description;
        MarkAsUpdated();
    }

    public void UpdateDefaultBranch(string? defaultBranch)
    {
        DefaultBranch = defaultBranch;
        MarkAsUpdated();
    }

    public void SetLlmSetting(Guid? llmSettingId)
    {
        LlmSettingId = llmSettingId;
        MarkAsUpdated();
    }

    public void UpdateAgentRules(string? agentRules)
    {
        AgentRules = agentRules;
        MarkAsUpdated();
    }

    /// <summary>
    /// Set or clear Azure Service Principal identity. Pass all three to set, all null to clear.
    /// </summary>
    public void UpdateAzureIdentity(string? clientId, string? clientSecret, string? tenantId)
    {
        AzureIdentityClientId = clientId;
        AzureIdentityClientSecret = clientSecret;
        AzureIdentityTenantId = tenantId;
        MarkAsUpdated();
    }
}
