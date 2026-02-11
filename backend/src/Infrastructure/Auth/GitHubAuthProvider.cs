namespace DevPilot.Infrastructure.Auth;

using System.Net.Http.Headers;
using System.Security.Claims;
using DevPilot.Application.Options;
using DevPilot.Application.Services;
using Octokit;

/// <summary>
/// GitHub OAuth provider – uses backend code exchange (GitHub is not OIDC-compliant).
/// </summary>
public class GitHubAuthProvider : IAuthProvider
{
    private readonly ProviderConfig _config;
    private readonly IHttpClientFactory _httpClientFactory;

    public string Name => "GitHub";
    public string Type => "BackendOAuth";

    public GitHubAuthProvider(ProviderConfig config, IHttpClientFactory httpClientFactory)
    {
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _httpClientFactory = httpClientFactory ?? throw new ArgumentNullException(nameof(httpClientFactory));
    }

    public string? BuildAuthorizationUrl(string? state = null)
    {
        var clientId = _config.ClientId ?? throw new InvalidOperationException("GitHub ClientId not configured");
        var redirectUri = _config.RedirectUri ?? "http://localhost:4200/auth/callback/GitHub";
        var scopes = _config.Scopes ?? "repo,read:org";

        var url = $"https://github.com/login/oauth/authorize" +
            $"?client_id={Uri.EscapeDataString(clientId)}" +
            $"&redirect_uri={Uri.EscapeDataString(redirectUri)}" +
            $"&scope={Uri.EscapeDataString(scopes)}";

        if (!string.IsNullOrEmpty(state))
            url += $"&state={Uri.EscapeDataString(state)}";

        return url;
    }

    public async Task<OAuthTokenResult> ExchangeCodeAsync(string code, string redirectUri, CancellationToken ct)
    {
        var clientId = _config.ClientId ?? throw new InvalidOperationException("GitHub ClientId not configured");
        var clientSecret = _config.ClientSecret ?? throw new InvalidOperationException("GitHub ClientSecret not configured");
        // Use configured redirect_uri if passed-in is empty (must match authorize request exactly)
        var effectiveRedirectUri = !string.IsNullOrWhiteSpace(redirectUri)
            ? redirectUri
            : (_config.RedirectUri ?? "http://localhost:4200/auth/callback/GitHub");

        using var httpClient = _httpClientFactory.CreateClient();
        httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var body = new FormUrlEncodedContent(new[]
        {
            new KeyValuePair<string, string>("client_id", clientId),
            new KeyValuePair<string, string>("client_secret", clientSecret),
            new KeyValuePair<string, string>("code", code),
            new KeyValuePair<string, string>("redirect_uri", effectiveRedirectUri)
        });

        var response = await httpClient.PostAsync("https://github.com/login/oauth/access_token", body, ct);
        var content = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"GitHub token exchange failed: {response.StatusCode} - {content}");

        var accessToken = ParseAccessToken(content);
        if (accessToken != null)
            return new OAuthTokenResult { AccessToken = accessToken };

        // Response may be 200 but JSON with error (e.g. bad_verification_code)
        throw new InvalidOperationException(
            $"Failed to parse access token from GitHub response: {content}. " +
            "Ensure the app is opened at the same URL as RedirectUri (e.g. http://localhost:4200, not 127.0.0.1), " +
            "the code has not been used or expired, and the GitHub OAuth app callback URL matches exactly.");
    }

    public async Task<ExternalUserProfile> GetUserProfileAsync(string accessToken, CancellationToken ct)
    {
        var client = new GitHubClient(new Octokit.ProductHeaderValue("DevPilot"))
        {
            Credentials = new Credentials(accessToken)
        };

        var user = await client.User.Current();

        return new ExternalUserProfile
        {
            ProviderUserId = user.Id.ToString(),
            DisplayName = user.Login,
            Email = user.Email
        };
    }

    public Task<ClaimsPrincipal> ValidateTokenAsync(string accessToken, CancellationToken ct)
        => throw new NotSupportedException("GitHub uses backend code exchange, not frontend token validation.");

    // ---- helpers ----

    private static string? ParseAccessToken(string response)
    {
        // Try JSON
        try
        {
            var doc = System.Text.Json.JsonDocument.Parse(response);
            if (doc.RootElement.TryGetProperty("access_token", out var tok))
                return tok.GetString();
        }
        catch { /* not JSON, try form-encoded */ }

        // form-encoded: access_token=xxx&token_type=bearer&scope=repo
        foreach (var part in response.Split('&'))
        {
            var kv = part.Split('=', 2);
            if (kv.Length == 2 && kv[0] == "access_token")
                return Uri.UnescapeDataString(kv[1]);
        }

        return null;
    }
}
