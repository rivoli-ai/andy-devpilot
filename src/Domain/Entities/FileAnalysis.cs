namespace DevPilot.Domain.Entities;

/// <summary>
/// Represents an AI analysis of a specific file in a repository
/// </summary>
public class FileAnalysis : Entity
{
    public Guid RepositoryId { get; private set; }
    public string FilePath { get; private set; } = string.Empty;
    public string Branch { get; private set; } = string.Empty;
    public string Explanation { get; private set; } = string.Empty;
    public string? KeyFunctions { get; private set; }
    public string? Complexity { get; private set; }
    public string? Suggestions { get; private set; }
    public DateTime AnalyzedAt { get; private set; }
    public string? Model { get; private set; }
    
    // Navigation property
    public Repository? Repository { get; private set; }

    protected FileAnalysis() : base() { }

    public FileAnalysis(
        Guid repositoryId,
        string filePath,
        string branch,
        string explanation,
        string? keyFunctions = null,
        string? complexity = null,
        string? suggestions = null,
        string? model = null) : base()
    {
        RepositoryId = repositoryId;
        FilePath = filePath ?? throw new ArgumentNullException(nameof(filePath));
        Branch = branch ?? throw new ArgumentNullException(nameof(branch));
        Explanation = explanation ?? throw new ArgumentNullException(nameof(explanation));
        KeyFunctions = keyFunctions;
        Complexity = complexity;
        Suggestions = suggestions;
        Model = model;
        AnalyzedAt = DateTime.UtcNow;
    }

    public void Update(
        string explanation,
        string? keyFunctions = null,
        string? complexity = null,
        string? suggestions = null,
        string? model = null)
    {
        Explanation = explanation ?? throw new ArgumentNullException(nameof(explanation));
        KeyFunctions = keyFunctions;
        Complexity = complexity;
        Suggestions = suggestions;
        Model = model;
        AnalyzedAt = DateTime.UtcNow;
        MarkAsUpdated();
    }
}
