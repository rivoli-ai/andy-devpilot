namespace DevPilot.Application.Services;

/// <summary>Surfaces unpublished repository files from server-local disk for the Code browser.</summary>
public interface IUnpublishedRepositoryFileStore
{
    /// <summary>Initial folder + README for a new unpublished repository.</summary>
    Task EnsureSeededAsync(
        Guid repositoryId,
        string displayName,
        string? description,
        CancellationToken cancellationToken = default);

    /// <summary>Creates the folder and README if the directory is missing (older rows).</summary>
    Task EnsurePresentAsync(
        Guid repositoryId,
        string displayName,
        string? description,
        CancellationToken cancellationToken = default);

    Task<RepositoryTreeDto> GetTreeAsync(
        Guid repositoryId,
        string? relativePath,
        string? branch,
        string? defaultBranch,
        CancellationToken cancellationToken = default);

    Task<RepositoryFileContentDto> GetFileContentAsync(
        Guid repositoryId,
        string relativePath,
        string? branch,
        string? defaultBranch,
        CancellationToken cancellationToken = default);

    IReadOnlyList<RepositoryBranchDto> GetBranches(string? defaultBranch);

    /// <summary>Creates parent directories; overwrites the file if it exists.</summary>
    Task WriteTextFileAsync(
        Guid repositoryId,
        string relativePath,
        string utf8Text,
        CancellationToken cancellationToken = default);

    /// <summary>Zip of all files for sandbox bootstrap (clone fallback).</summary>
    Task<Stream> OpenArchiveAsZipStreamAsync(Guid repositoryId, CancellationToken cancellationToken = default);

    /// <summary>Replace on-disk project tree with contents of a zip (UTF-8 paths, no ..).</summary>
    Task ReplaceTreeFromZipAsync(Guid repositoryId, Stream zipStream, CancellationToken cancellationToken = default);
}
