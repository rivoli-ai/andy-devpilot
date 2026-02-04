namespace DevPilot.Domain.Entities;

/// <summary>
/// Represents a global code analysis for a repository
/// </summary>
public class CodeAnalysis : Entity
{
    public Guid RepositoryId { get; private set; }
    public string Branch { get; private set; } = string.Empty;
    public string Summary { get; private set; } = string.Empty;
    public string? Architecture { get; private set; }
    public string? KeyComponents { get; private set; }
    public string? Dependencies { get; private set; }
    public string? Recommendations { get; private set; }
    public DateTime AnalyzedAt { get; private set; }
    public string? Model { get; private set; }
    
    // Navigation property
    public Repository? Repository { get; private set; }

    protected CodeAnalysis() : base() { }

    public CodeAnalysis(
        Guid repositoryId,
        string branch,
        string summary,
        string? architecture = null,
        string? keyComponents = null,
        string? dependencies = null,
        string? recommendations = null,
        string? model = null) : base()
    {
        RepositoryId = repositoryId;
        Branch = branch ?? throw new ArgumentNullException(nameof(branch));
        Summary = summary ?? throw new ArgumentNullException(nameof(summary));
        Architecture = architecture;
        KeyComponents = keyComponents;
        Dependencies = dependencies;
        Recommendations = recommendations;
        Model = model;
        AnalyzedAt = DateTime.UtcNow;
    }

    public void Update(
        string summary,
        string? architecture = null,
        string? keyComponents = null,
        string? dependencies = null,
        string? recommendations = null,
        string? model = null)
    {
        Summary = summary ?? throw new ArgumentNullException(nameof(summary));
        Architecture = architecture;
        KeyComponents = keyComponents;
        Dependencies = dependencies;
        Recommendations = recommendations;
        Model = model;
        AnalyzedAt = DateTime.UtcNow;
        MarkAsUpdated();
    }
}
