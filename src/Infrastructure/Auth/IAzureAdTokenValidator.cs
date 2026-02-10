namespace DevPilot.Infrastructure.Auth;

using System.Security.Claims;

/// <summary>
/// Validates Azure AD / Entra ID issued JWT access tokens (e.g. from a frontend SPA using MSAL).
/// </summary>
public interface IAzureAdTokenValidator
{
    /// <summary>
    /// Validates an Azure AD access token and returns the claims principal.
    /// </summary>
    /// <param name="accessToken">The Bearer token string (without "Bearer " prefix).</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>ClaimsPrincipal with identity and claims from the token.</returns>
    /// <exception cref="ArgumentException">When the token is invalid (signature, audience, issuer, expiry).</exception>
    Task<ClaimsPrincipal> ValidateAzureAdTokenAsync(string accessToken, CancellationToken cancellationToken = default);
}
