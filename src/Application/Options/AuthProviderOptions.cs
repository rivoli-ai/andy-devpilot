namespace DevPilot.Application.Options;

/// <summary>
/// Strongly-typed options for the AuthProviders configuration section.
/// </summary>
public class AuthProvidersOptions
{
    public const string SectionName = "AuthProviders";

    /// <summary>
    /// Dictionary of provider name -> config.  Keys match the JSON property names
    /// (e.g. "Local", "GitHub", "AzureAd", "Duende").
    /// </summary>
    public Dictionary<string, ProviderConfig> Providers { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Helper: get all enabled providers.
    /// </summary>
    public IEnumerable<KeyValuePair<string, ProviderConfig>> GetEnabledProviders()
        => Providers.Where(p => p.Value.Enabled);
}

/// <summary>
/// Configuration for a single authentication provider.
/// </summary>
public class ProviderConfig
{
    /// <summary>Whether this provider is active.</summary>
    public bool Enabled { get; set; }

    /// <summary>
    /// Discriminator: "Local" | "BackendOAuth" | "FrontendOidc".
    /// Not required for the Local provider (defaults to "Local").
    /// </summary>
    public string Type { get; set; } = "Local";

    /// <summary>OIDC authority / issuer URL (FrontendOidc providers).</summary>
    public string? Authority { get; set; }

    /// <summary>
    /// Backend (confidential) client ID. Used for backend code exchange (BackendOAuth)
    /// and as a valid token audience during validation (FrontendOidc).
    /// Never exposed to the frontend for FrontendOidc providers.
    /// </summary>
    public string? ClientId { get; set; }

    /// <summary>
    /// Frontend SPA (public) client ID. Used by the frontend OIDC library to initiate
    /// the authorization flow. Only relevant for FrontendOidc providers.
    /// This is the value sent to the frontend via GET /api/auth/config.
    /// If not set, falls back to <see cref="ClientId"/>.
    /// </summary>
    public string? SpaClientId { get; set; }

    /// <summary>OAuth client secret (BackendOAuth providers only – never exposed to frontend).</summary>
    public string? ClientSecret { get; set; }

    /// <summary>Azure AD tenant ID (AzureAd provider).</summary>
    public string? TenantId { get; set; }

    /// <summary>OAuth redirect URI used by the backend code-exchange flow.</summary>
    public string? RedirectUri { get; set; }

    /// <summary>Space- or comma-separated scopes.</summary>
    public string? Scopes { get; set; }

    /// <summary>
    /// Optional profile endpoint to call after obtaining the access token
    /// to retrieve the external user profile (e.g. Azure DevOps profile API).
    /// </summary>
    public string? ProfileEndpoint { get; set; }
}
