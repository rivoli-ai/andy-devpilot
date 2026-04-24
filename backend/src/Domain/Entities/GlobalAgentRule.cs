namespace DevPilot.Domain.Entities;

/// <summary>Admin-defined named agent rule template, visible to all users for copying into repository profiles.</summary>
public class GlobalAgentRule : Entity
{
    public string Name { get; private set; }
    public string Body { get; private set; }
    public int SortOrder { get; private set; }

    private GlobalAgentRule() { }

    public GlobalAgentRule(string name, string body, int sortOrder)
    {
        Name = name ?? throw new ArgumentNullException(nameof(name));
        Body = body ?? throw new ArgumentNullException(nameof(body));
        SortOrder = sortOrder;
    }

    public void Update(string name, string body, int sortOrder)
    {
        Name = name ?? throw new ArgumentNullException(nameof(name));
        Body = body ?? throw new ArgumentNullException(nameof(body));
        SortOrder = sortOrder;
        MarkAsUpdated();
    }
}
