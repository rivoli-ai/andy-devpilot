namespace DevPilot.Domain.Entities;

/// <summary>
/// User entity representing an authenticated user
/// Supports multiple authentication methods: Email/Password, GitHub OAuth, Microsoft OAuth
/// </summary>
public class User : Entity
{
    public string Email { get; private set; }
    public string? Name { get; private set; }
    public string? PasswordHash { get; private set; } // For email/password authentication
    public bool EmailVerified { get; private set; } // Email verification status
    
    // Legacy fields - kept for backward compatibility during migration
    // New code should use LinkedProviders table
    public string? GitHubUsername { get; private set; }
    public string? GitHubAccessToken { get; private set; }
    public DateTime? GitHubTokenExpiresAt { get; private set; }
    public string? AzureDevOpsAccessToken { get; private set; }
    public DateTime? AzureDevOpsTokenExpiresAt { get; private set; }
    public string? AzureDevOpsOrganization { get; private set; }
    
    // AI Configuration
    public string? AiProvider { get; private set; }  // openai, anthropic, ollama, custom
    public string? AiApiKey { get; private set; }
    public string? AiModel { get; private set; }
    public string? AiBaseUrl { get; private set; }

    // Navigation properties
    public List<Repository> Repositories { get; private set; } = new();
    public List<LinkedProvider> LinkedProviders { get; private set; } = new();

    private User() { }

    public User(string email, string? name = null)
    {
        Email = email ?? throw new ArgumentNullException(nameof(email));
        Name = name;
        EmailVerified = false;
    }

    /// <summary>
    /// Create a user with email/password authentication
    /// </summary>
    public static User CreateWithPassword(string email, string passwordHash, string? name = null)
    {
        var user = new User(email, name)
        {
            PasswordHash = passwordHash
        };
        return user;
    }

    public void UpdateName(string? name)
    {
        Name = name;
        MarkAsUpdated();
    }

    public void SetPasswordHash(string passwordHash)
    {
        PasswordHash = passwordHash;
        MarkAsUpdated();
    }

    public void VerifyEmail()
    {
        EmailVerified = true;
        MarkAsUpdated();
    }

    public bool HasPassword()
    {
        return !string.IsNullOrEmpty(PasswordHash);
    }

    // Legacy methods - kept for backward compatibility
    public void UpdateGitHubToken(string? accessToken, DateTime? expiresAt = null)
    {
        GitHubAccessToken = accessToken;
        GitHubTokenExpiresAt = expiresAt;
        MarkAsUpdated();
    }

    public void UpdateGitHubUsername(string? username)
    {
        GitHubUsername = username;
        MarkAsUpdated();
    }

    public void UpdateAzureDevOpsToken(string? accessToken, DateTime? expiresAt = null)
    {
        AzureDevOpsAccessToken = accessToken;
        AzureDevOpsTokenExpiresAt = expiresAt;
        MarkAsUpdated();
    }

    public void UpdateAzureDevOpsSettings(string? organization, string? accessToken)
    {
        AzureDevOpsOrganization = organization;
        if (accessToken != null)
        {
            AzureDevOpsAccessToken = accessToken;
        }
        MarkAsUpdated();
    }

    public void UpdateAiSettings(string? provider, string? apiKey, string? model, string? baseUrl)
    {
        AiProvider = provider;
        if (apiKey != null)
        {
            AiApiKey = apiKey;
        }
        AiModel = model;
        AiBaseUrl = baseUrl;
        MarkAsUpdated();
    }

    public void ClearAiSettings()
    {
        AiProvider = null;
        AiApiKey = null;
        AiModel = null;
        AiBaseUrl = null;
        MarkAsUpdated();
    }
}
