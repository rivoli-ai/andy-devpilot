namespace DevPilot.Infrastructure.Auth;

using Microsoft.Extensions.Configuration;

/// <summary>
/// Matches the configured <c>AdminEmail</c> (bootstrap administrator), including Microsoft #EXT# external user emails.
/// </summary>
public static class AdminEmailBootstrap
{
    /// <summary>
    /// Returns true when <paramref name="email"/> is the configured admin email.
    /// </summary>
    public static bool IsMatch(IConfiguration configuration, string email)
    {
        var adminEmail = (configuration["AdminEmail"] ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(adminEmail)) return false;

        var candidate = email.Trim();
        if (string.Equals(adminEmail, candidate, StringComparison.OrdinalIgnoreCase))
            return true;

        var extIdx = candidate.IndexOf("#EXT#", StringComparison.OrdinalIgnoreCase);
        if (extIdx > 0)
        {
            var localPart = candidate[..extIdx];
            var lastUnderscore = localPart.LastIndexOf('_');
            if (lastUnderscore > 0)
            {
                var recovered = localPart[..lastUnderscore] + "@" + localPart[(lastUnderscore + 1)..];
                if (string.Equals(adminEmail, recovered, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
        }

        return false;
    }
}
