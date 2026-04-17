namespace DevPilot.Domain.Entities;

/// <summary>Named AI agent rules profile for a repository (one of many per repo).</summary>
public class RepositoryAgentRule : Entity
{
    public Guid RepositoryId { get; private set; }
    public string Name { get; private set; }
    public string Body { get; private set; }
    public bool IsDefault { get; private set; }
    public int SortOrder { get; private set; }

    public Repository Repository { get; private set; } = null!;

    private RepositoryAgentRule() { }

    public RepositoryAgentRule(Guid repositoryId, string name, string body, bool isDefault, int sortOrder)
    {
        RepositoryId = repositoryId;
        Name = name ?? throw new ArgumentNullException(nameof(name));
        Body = body ?? throw new ArgumentNullException(nameof(body));
        IsDefault = isDefault;
        SortOrder = sortOrder;
    }

    public void Update(string name, string body, bool isDefault, int sortOrder)
    {
        Name = name ?? throw new ArgumentNullException(nameof(name));
        Body = body ?? throw new ArgumentNullException(nameof(body));
        IsDefault = isDefault;
        SortOrder = sortOrder;
        MarkAsUpdated();
    }
}
