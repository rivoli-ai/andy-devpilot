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

    // Navigation properties
    public List<Epic> Epics { get; private set; } = new();

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
}
