namespace DevPilot.Application.Options;

/// <summary>Filesystem root for per-user unpublished (local) repository content.</summary>
public class UnpublishedRepositoryOptions
{
    public const string SectionName = "UnpublishedRepositories";

    /// <summary>Absolute path, or null/empty to use ContentRootPath/App_Data/unpublished-repos.</summary>
    public string? RootPath { get; set; }

    /// <summary>Base URL the sandbox can reach to download a signed project zip (e.g. http://host.docker.internal:5000 from container to host). If empty, the API uses the current request host when generating clone/sandbox URLs (browser may differ from the sandbox network).</summary>
    public string? DownloadBaseUrl { get; set; }

    /// <summary>Optional HMAC key for /unpublished/sandbox-archive. If empty, JWT:SecretKey is used.</summary>
    public string? ArchiveSigningKey { get; set; }
}
