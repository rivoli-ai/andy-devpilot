namespace DevPilot.Infrastructure.Auth;

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using DevPilot.Application.Options;
using DevPilot.Application.Services;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

/// <summary>
/// Generic OIDC provider for frontend-delegated flows (Azure AD, Duende, etc.).
/// The frontend obtains an access token via angular-auth-oidc-client; the backend
/// validates the token's signature, issuer, audience and lifetime using OIDC discovery.
/// </summary>
public class OidcAuthProvider : IAuthProvider
{
    private readonly string _name;
    private readonly ProviderConfig _config;
    private readonly IConfigurationManager<OpenIdConnectConfiguration> _configManager;
    private readonly string[] _validAudiences;
    private readonly IHttpClientFactory _httpClientFactory;

    public string Name => _name;
    public string Type => "FrontendOidc";

    public OidcAuthProvider(string name, ProviderConfig config, IHttpClientFactory httpClientFactory)
    {
        _name = name ?? throw new ArgumentNullException(nameof(name));
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _httpClientFactory = httpClientFactory ?? throw new ArgumentNullException(nameof(httpClientFactory));

        var authority = config.Authority ?? throw new InvalidOperationException($"Authority is required for OIDC provider '{name}'");
        if (!Uri.TryCreate(authority, UriKind.Absolute, out var authorityUri))
            throw new InvalidOperationException($"Authority must be an absolute URI for OIDC provider '{name}'.");

        var metadataAddress = new Uri(authorityUri, ".well-known/openid-configuration").ToString();
        var authorityIsHttps = string.Equals(authorityUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);

        // Never disable server certificate validation (Sonar S4830). For local HTTPS OIDC
        // (e.g. Duende), trust the dev certificate: dotnet dev-certs https --trust
        if (!authorityIsHttps)
        {
            // Plain HTTP metadata (typical local Duende). No certificate involved.
            using var httpForDiscovery = new HttpClient();
            _configManager = new ConfigurationManager<OpenIdConnectConfiguration>(
                metadataAddress,
                new OpenIdConnectConfigurationRetriever(),
                new HttpDocumentRetriever(httpForDiscovery) { RequireHttps = false });
        }
        else
        {
            _configManager = new ConfigurationManager<OpenIdConnectConfiguration>(
                metadataAddress,
                new OpenIdConnectConfigurationRetriever());
        }

        var audiences = new List<string>();
        if (!string.IsNullOrEmpty(config.ClientId))
            audiences.Add(config.ClientId);
        if (!string.IsNullOrEmpty(config.SpaClientId))
            audiences.Add(config.SpaClientId);
        _validAudiences = audiences.Distinct().ToArray();
    }

    public async Task<ClaimsPrincipal> ValidateTokenAsync(string accessToken, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(accessToken))
            throw new ArgumentException("Access token is required.", nameof(accessToken));

        var oidcConfig = await _configManager.GetConfigurationAsync(ct).ConfigureAwait(false);
        var handler = new JwtSecurityTokenHandler();

        var parameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = oidcConfig.Issuer,
            ValidateAudience = _validAudiences.Length > 0,
            ValidAudiences = _validAudiences,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromMinutes(2),
            IssuerSigningKeys = oidcConfig.SigningKeys,
            ValidateIssuerSigningKey = true
        };

        return handler.ValidateToken(accessToken, parameters, out _);
    }

    public async Task<ExternalUserProfile> GetUserProfileAsync(string accessToken, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(_config.ProfileEndpoint))
            return await FetchProfileFromEndpoint(accessToken, ct);

        var handler = new JwtSecurityTokenHandler();
        if (handler.CanReadToken(accessToken))
        {
            var jwt = handler.ReadJwtToken(accessToken);
            return new ExternalUserProfile
            {
                ProviderUserId = jwt.Claims.FirstOrDefault(c => c.Type == "oid" || c.Type == "sub")?.Value ?? "",
                DisplayName = jwt.Claims.FirstOrDefault(c => c.Type == "name" || c.Type == "preferred_username")?.Value,
                Email = jwt.Claims.FirstOrDefault(c => c.Type == "email" || c.Type == "upn")?.Value
            };
        }

        throw new InvalidOperationException($"Cannot extract user profile for provider '{_name}': no profile endpoint configured and token is not a readable JWT.");
    }

    public Task<OAuthTokenResult> ExchangeCodeAsync(string code, string redirectUri, CancellationToken ct)
        => throw new NotSupportedException($"OIDC provider '{_name}' uses frontend-delegated flow; code exchange is not supported.");

    public string? BuildAuthorizationUrl(string? state = null) => null;

    private async Task<ExternalUserProfile> FetchProfileFromEndpoint(string accessToken, CancellationToken ct)
    {
        var httpClient = _httpClientFactory.CreateClient();
        using var _ = httpClient;
        httpClient.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);

        var response = await httpClient.GetAsync(_config.ProfileEndpoint, ct);
        var content = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Profile endpoint for '{_name}' returned {response.StatusCode}: {content}");

        var doc = System.Text.Json.JsonDocument.Parse(content);
        var root = doc.RootElement;

        var id = TryGet(root, "id", "sub", "oid") ?? "";
        var displayName = TryGet(root, "displayName", "name", "preferred_username");
        var email = TryGet(root, "mail", "email", "userPrincipalName", "emailAddress");

        return new ExternalUserProfile
        {
            ProviderUserId = id,
            DisplayName = displayName,
            Email = email
        };
    }

    private static string? TryGet(System.Text.Json.JsonElement el, params string[] names)
    {
        foreach (var n in names)
        {
            if (el.TryGetProperty(n, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                var s = v.GetString();
                if (!string.IsNullOrWhiteSpace(s)) return s;
            }
        }
        return null;
    }
}
