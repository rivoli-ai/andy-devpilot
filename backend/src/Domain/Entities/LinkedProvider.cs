namespace DevPilot.Domain.Entities;

/// <summary>
/// Represents a linked OAuth provider for a user (GitHub, Microsoft, AzureDevOps)
/// Allows users to link multiple providers for repository sync
/// </summary>
public class LinkedProvider : Entity
{
    public Guid UserId { get; private set; }
    public string Provider { get; private set; } // GitHub, Microsoft, AzureDevOps
    public string ProviderUserId { get; private set; } // Provider's unique user ID
    public string? ProviderUsername { get; private set; } // Provider's username (optional)
    public string AccessToken { get; private set; }
    public string? RefreshToken { get; private set; }
    public DateTime? TokenExpiresAt { get; private set; }

    // Navigation property
    public User? User { get; private set; }

    private LinkedProvider() { }

    public LinkedProvider(
        Guid userId,
        string provider,
        string providerUserId,
        string accessToken,
        string? providerUsername = null,
        string? refreshToken = null,
        DateTime? tokenExpiresAt = null)
    {
        UserId = userId;
        Provider = provider ?? throw new ArgumentNullException(nameof(provider));
        ProviderUserId = providerUserId ?? throw new ArgumentNullException(nameof(providerUserId));
        AccessToken = accessToken ?? throw new ArgumentNullException(nameof(accessToken));
        ProviderUsername = providerUsername;
        RefreshToken = refreshToken;
        TokenExpiresAt = tokenExpiresAt;
    }

    public void UpdateToken(string accessToken, string? refreshToken = null, DateTime? expiresAt = null)
    {
        AccessToken = accessToken ?? throw new ArgumentNullException(nameof(accessToken));
        RefreshToken = refreshToken;
        TokenExpiresAt = expiresAt;
        MarkAsUpdated();
    }

    public void UpdateProviderUsername(string? username)
    {
        ProviderUsername = username;
        MarkAsUpdated();
    }

    public bool IsTokenExpired()
    {
        return TokenExpiresAt.HasValue && TokenExpiresAt.Value <= DateTime.UtcNow;
    }
}

/// <summary>
/// Provider type constants
/// </summary>
public static class ProviderTypes
{
    public const string GitHub = "GitHub";
    public const string Microsoft = "Microsoft";
    public const string AzureDevOps = "AzureDevOps";
}
