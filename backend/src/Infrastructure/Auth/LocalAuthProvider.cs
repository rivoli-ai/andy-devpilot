namespace DevPilot.Infrastructure.Auth;

using System.Security.Claims;
using DevPilot.Application.Services;

/// <summary>
/// Local (email/password) authentication provider.
/// Wraps the existing <see cref="AuthenticationService"/>.
/// Does not participate in OAuth/OIDC flows.
/// </summary>
public class LocalAuthProvider : IAuthProvider
{
    public string Name => "Local";
    public string Type => "Local";

    public string? BuildAuthorizationUrl(string? state = null) => null;

    public Task<OAuthTokenResult> ExchangeCodeAsync(string code, string redirectUri, CancellationToken ct)
        => throw new NotSupportedException("Local provider does not support code exchange.");

    public Task<ClaimsPrincipal> ValidateTokenAsync(string accessToken, CancellationToken ct)
        => throw new NotSupportedException("Local provider does not validate external tokens.");

    public Task<ExternalUserProfile> GetUserProfileAsync(string accessToken, CancellationToken ct)
        => throw new NotSupportedException("Local provider does not have an external user profile.");
}
