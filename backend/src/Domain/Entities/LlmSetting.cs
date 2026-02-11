namespace DevPilot.Domain.Entities;

/// <summary>
/// User-defined LLM configuration (OpenAI, Anthropic, Ollama, etc.).
/// User can have multiple; one can be marked as default for repositories that don't override.
/// </summary>
public class LlmSetting : Entity
{
    public Guid UserId { get; private set; }
    public string Name { get; private set; }
    public string Provider { get; private set; }  // openai, anthropic, ollama, custom
    public string? ApiKey { get; private set; }
    public string Model { get; private set; }
    public string? BaseUrl { get; private set; }
    public bool IsDefault { get; private set; }

    private LlmSetting() { }

    public LlmSetting(
        Guid userId,
        string name,
        string provider,
        string? apiKey,
        string model,
        string? baseUrl,
        bool isDefault = false)
    {
        UserId = userId;
        Name = name ?? throw new ArgumentNullException(nameof(name));
        Provider = provider ?? throw new ArgumentNullException(nameof(provider));
        ApiKey = apiKey;
        Model = model ?? throw new ArgumentNullException(nameof(model));
        BaseUrl = baseUrl;
        IsDefault = isDefault;
    }

    public void Update(string name, string? apiKey, string model, string? baseUrl)
    {
        Name = name ?? Name;
        if (apiKey != null) ApiKey = apiKey;
        Model = model ?? Model;
        BaseUrl = baseUrl;
        MarkAsUpdated();
    }

    public void SetDefault(bool isDefault)
    {
        IsDefault = isDefault;
        MarkAsUpdated();
    }
}
