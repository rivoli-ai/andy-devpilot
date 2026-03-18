namespace DevPilot.Domain.Entities;

/// <summary>
/// LLM configuration (OpenAI, Anthropic, Ollama, etc.).
/// When <see cref="UserId"/> is null the record is a shared/global provider created by a super-admin
/// and visible to all users. When <see cref="UserId"/> has a value the record is personal to that user.
/// </summary>
public class LlmSetting : Entity
{
    /// <summary>null for shared/global providers; user's id for personal providers.</summary>
    public Guid? UserId { get; private set; }
    public string Name { get; private set; }
    public string Provider { get; private set; }  // openai, anthropic, ollama, custom
    public string? ApiKey { get; private set; }
    public string Model { get; private set; }
    public string? BaseUrl { get; private set; }
    public bool IsDefault { get; private set; }

    /// <summary>True when this is a shared/admin-created provider (UserId == null).</summary>
    public bool IsShared => UserId == null;

    private LlmSetting() { }

    /// <summary>Create a personal LLM setting owned by a specific user.</summary>
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

    /// <summary>Create a shared/global LLM setting (no owner — visible to all users).</summary>
    public static LlmSetting CreateShared(string name, string provider, string? apiKey, string model, string? baseUrl)
        => new()
        {
            UserId = null,
            Name = name ?? throw new ArgumentNullException(nameof(name)),
            Provider = provider ?? throw new ArgumentNullException(nameof(provider)),
            ApiKey = apiKey,
            Model = model ?? throw new ArgumentNullException(nameof(model)),
            BaseUrl = baseUrl,
            IsDefault = false,
        };

    public void Update(string? name, string? apiKey, string? model, string? baseUrl, string? provider = null)
    {
        if (name != null) Name = name;
        if (apiKey != null) ApiKey = apiKey;
        if (model != null) Model = model;
        if (baseUrl != null) BaseUrl = baseUrl;
        if (provider != null) Provider = provider;
        MarkAsUpdated();
    }

    public void SetDefault(bool isDefault)
    {
        IsDefault = isDefault;
        MarkAsUpdated();
    }
}
