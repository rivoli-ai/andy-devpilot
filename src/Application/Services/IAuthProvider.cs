namespace DevPilot.Application.Services;

using System.Security.Claims;

/// <summary>
/// Abstraction over an external (or local) authentication provider.
/// Each concrete implementation handles one provider type.
/// </summary>
public interface IAuthProvider
{
    /// <summary>Provider key (e.g. "GitHub", "AzureAd", "Duende", "Local").</summary>
    string Name { get; }

    /// <summary>Provider type: "Local", "BackendOAuth", or "FrontendOidc".</summary>
    string Type { get; }

    /// <summary>
    /// Exchange an authorization code for an access token (BackendOAuth only).
    /// </summary>
    Task<OAuthTokenResult> ExchangeCodeAsync(string code, string redirectUri, CancellationToken ct);

    /// <summary>
    /// Validate a token obtained by the frontend and return the claims (FrontendOidc only).
    /// </summary>
    Task<ClaimsPrincipal> ValidateTokenAsync(string accessToken, CancellationToken ct);

    /// <summary>
    /// Fetch the external user profile using the given access token.
    /// </summary>
    Task<ExternalUserProfile> GetUserProfileAsync(string accessToken, CancellationToken ct);

    /// <summary>
    /// Build the authorization URL the frontend should redirect to (BackendOAuth only).
    /// Returns null for FrontendOidc providers (frontend builds the URL via OIDC lib).
    /// </summary>
    string? BuildAuthorizationUrl(string? state = null);
}

/// <summary>
/// Result of exchanging an authorization code for tokens.
/// </summary>
public class OAuthTokenResult
{
    public required string AccessToken { get; set; }
    public string? RefreshToken { get; set; }
    public DateTime? ExpiresAt { get; set; }
}

/// <summary>
/// Normalized external user profile returned by any provider.
/// </summary>
public class ExternalUserProfile
{
    /// <summary>Provider-specific unique user ID.</summary>
    public required string ProviderUserId { get; set; }

    /// <summary>Display name / username.</summary>
    public string? DisplayName { get; set; }

    /// <summary>Email address (may be null for some providers).</summary>
    public string? Email { get; set; }
}
