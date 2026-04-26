using System.Security.Cryptography;
using System.Text;

namespace DevPilot.API;

/// <summary>HMAC token so the sandbox (without JWT) can download a zip of a local (unpublished) project.</summary>
public static class UnpublishedArchiveToken
{
    public static string Sign(string secret, Guid repositoryId, long expUnixSeconds)
    {
        if (string.IsNullOrEmpty(secret))
        {
            throw new InvalidOperationException("Signing key is not configured");
        }

        var payload = $"{repositoryId:N}|{expUnixSeconds}";
        using var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return Base64Url(h.ComputeHash(Encoding.UTF8.GetBytes(payload)));
    }

    public static bool Validate(
        string secret,
        Guid repositoryId,
        long expUnixSeconds,
        string signature,
        out string? error)
    {
        error = null;
        if (string.IsNullOrEmpty(secret) || string.IsNullOrEmpty(signature))
        {
            error = "Invalid token";
            return false;
        }

        if (expUnixSeconds < DateTimeOffset.UtcNow.ToUnixTimeSeconds())
        {
            error = "Link expired";
            return false;
        }

        var expected = Sign(secret, repositoryId, expUnixSeconds);
        if (expected != signature)
        {
            error = "Invalid signature";
            return false;
        }

        return true;
    }

    private static string Base64Url(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
