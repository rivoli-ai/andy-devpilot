namespace DevPilot.Infrastructure.Auth;

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.Extensions.Configuration;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

/// <summary>
/// Validates Azure AD / Entra ID issued JWT access tokens.
/// Uses OpenID Connect discovery to get signing keys (no client secret required).
/// </summary>
public class AzureAdTokenValidator : IAzureAdTokenValidator
{
    private readonly IConfigurationManager<OpenIdConnectConfiguration> _configManager;
    private readonly string[] _validAudiences;

    // Azure DevOps resource ID (used as audience when scope is 499b84ac-1321-427f-aa17-267ca6975798/user_impersonation)
    private const string AzureDevOpsAudience = "499b84ac-1321-427f-aa17-267ca6975798";

    public AzureAdTokenValidator(IConfiguration configuration)
    {
        var config = configuration ?? throw new ArgumentNullException(nameof(configuration));
        var tenantId = config["AzureDevOps:AzureAd:TenantId"]
            ?? config["Microsoft:TenantId"]
            ?? "common";
        var clientId = config["AzureDevOps:AzureAd:ClientId"]
            ?? config["Microsoft:ClientId"];
        // Token audience can be the SPA client id or the Azure DevOps resource ID
        _validAudiences = new[] { AzureDevOpsAudience }
            .Concat(string.IsNullOrEmpty(clientId) ? [] : new[] { clientId })
            .Distinct()
            .ToArray();

        var authority = $"https://login.microsoftonline.com/{tenantId}/v2.0";
        var metadataAddress = $"{authority}/.well-known/openid-configuration";
        _configManager = new ConfigurationManager<OpenIdConnectConfiguration>(
            metadataAddress,
            new OpenIdConnectConfigurationRetriever());
    }

    /// <inheritdoc />
    public async Task<ClaimsPrincipal> ValidateAzureAdTokenAsync(string accessToken, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(accessToken))
            throw new ArgumentException("Access token is required.", nameof(accessToken));

        var config = await _configManager.GetConfigurationAsync(cancellationToken).ConfigureAwait(false);
        var handler = new JwtSecurityTokenHandler();

        var validationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = config.Issuer,
            ValidateAudience = true,
            ValidAudiences = _validAudiences,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromMinutes(2),
            IssuerSigningKeys = config.SigningKeys,
            ValidateIssuerSigningKey = true
        };

        var principal = handler.ValidateToken(accessToken, validationParameters, out _);
        return principal;
    }
}
