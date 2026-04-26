using System.Globalization;
using System.IO.Compression;
using System.Text;
using DevPilot.Application.Options;
using DevPilot.Application.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace DevPilot.Infrastructure.Services;

/// <summary>Stores unpublished repository files under App_Data/unpublished-repos/{guid}.</summary>
public sealed class UnpublishedRepositoryFileStore : IUnpublishedRepositoryFileStore
{
    private const string DefaultVirtualBranch = "main";
    private readonly IWebHostEnvironment _hostEnvironment;
    private readonly IOptions<UnpublishedRepositoryOptions> _options;
    private readonly ILogger<UnpublishedRepositoryFileStore> _logger;

    public UnpublishedRepositoryFileStore(
        IWebHostEnvironment hostEnvironment,
        IOptions<UnpublishedRepositoryOptions> options,
        ILogger<UnpublishedRepositoryFileStore> logger)
    {
        _hostEnvironment = hostEnvironment;
        _options = options;
        _logger = logger;
    }

    private string ResolveBaseDirectory()
    {
        var custom = _options.Value.RootPath;
        if (!string.IsNullOrWhiteSpace(custom))
        {
            return Path.GetFullPath(custom);
        }

        return Path.GetFullPath(
            Path.Combine(_hostEnvironment.ContentRootPath, "App_Data", "unpublished-repos"));
    }

    private string GetRepositoryRoot(Guid repositoryId)
    {
        return Path.GetFullPath(Path.Combine(ResolveBaseDirectory(), repositoryId.ToString("D")));
    }

    private static void AssertPathWithinRoot(string rootFullPath, string fileFullPath)
    {
        var root = rootFullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var f = fileFullPath;
        if (!f.StartsWith(root, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Path escapes repository root");
        }
    }

    public async Task EnsureSeededAsync(
        Guid repositoryId,
        string displayName,
        string? description,
        CancellationToken cancellationToken = default)
    {
        await WriteReadmeIfNeededAsync(repositoryId, displayName, description, force: false, cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task EnsurePresentAsync(
        Guid repositoryId,
        string displayName,
        string? description,
        CancellationToken cancellationToken = default)
    {
        var root = GetRepositoryRoot(repositoryId);
        if (!Directory.Exists(root))
        {
            await WriteReadmeIfNeededAsync(repositoryId, displayName, description, force: true, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task WriteReadmeIfNeededAsync(
        Guid repositoryId,
        string displayName,
        string? description,
        bool force,
        CancellationToken cancellationToken)
    {
        var root = GetRepositoryRoot(repositoryId);
        Directory.CreateDirectory(root);
        var readme = Path.Combine(root, "README.md");
        if (!force && File.Exists(readme))
        {
            return;
        }

        var body = new StringBuilder();
        body.AppendLine(CultureInfo.InvariantCulture, $"# {displayName.Trim()}");
        body.AppendLine();
        body.AppendLine("Local project files live here in the app until you publish to GitHub or Azure DevOps.");
        body.AppendLine();
        if (!string.IsNullOrWhiteSpace(description))
        {
            body.AppendLine(description.Trim());
            body.AppendLine();
        }

        await File.WriteAllTextAsync(readme, body.ToString(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), cancellationToken)
            .ConfigureAwait(false);
        _logger.LogInformation("Seeded unpublished repo disk folder for {Id}", repositoryId);
    }

    public Task<RepositoryTreeDto> GetTreeAsync(
        Guid repositoryId,
        string? relativePath,
        string? branch,
        string? defaultBranch,
        CancellationToken cancellationToken = default)
    {
        if (!string.IsNullOrEmpty(branch) && !BranchMatches(localDefault: defaultBranch, branch))
        {
            var dto = new RepositoryTreeDto
            {
                Path = NormalizeKey(relativePath) ?? string.Empty,
                Branch = defaultBranch ?? DefaultVirtualBranch,
                Items = new List<RepositoryTreeItemDto>()
            };
            return Task.FromResult(dto);
        }

        var root = GetRepositoryRoot(repositoryId);
        if (!Directory.Exists(root))
        {
            return Task.FromResult(new RepositoryTreeDto
            {
                Path = NormalizeKey(relativePath) ?? string.Empty,
                Branch = defaultBranch ?? DefaultVirtualBranch,
                Items = new List<RepositoryTreeItemDto>()
            });
        }

        var virtualBase = (NormalizeKey(relativePath) ?? string.Empty).Replace('/', Path.DirectorySeparatorChar);
        string fullDir = string.IsNullOrEmpty(virtualBase) ? root : Path.GetFullPath(Path.Combine(root, virtualBase));
        AssertPathWithinRoot(root, fullDir);
        if (!Directory.Exists(fullDir))
        {
            throw new FileNotFoundException("Directory not found", relativePath);
        }

        var items = new List<RepositoryTreeItemDto>();
        foreach (var entry in new DirectoryInfo(fullDir).EnumerateFileSystemInfos())
        {
            if (entry is DirectoryInfo d)
            {
                var p = ToVirtualPath(root, d.FullName);
                items.Add(new RepositoryTreeItemDto
                {
                    Name = d.Name,
                    Path = p,
                    Type = "dir",
                    Size = null,
                    Sha = null,
                    Url = null
                });
            }
            else if (entry is FileInfo f)
            {
                var p = ToVirtualPath(root, f.FullName);
                items.Add(new RepositoryTreeItemDto
                {
                    Name = f.Name,
                    Path = p,
                    Type = "file",
                    Size = f.Length,
                    Sha = null,
                    Url = null
                });
            }
        }

        items = items
            .OrderBy(x => x.Type == "file" ? 1 : 0)
            .ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return Task.FromResult(new RepositoryTreeDto
        {
            Path = NormalizeKey(relativePath) ?? string.Empty,
            Branch = defaultBranch ?? DefaultVirtualBranch,
            Items = items
        });
    }

    public async Task<RepositoryFileContentDto> GetFileContentAsync(
        Guid repositoryId,
        string relativePath,
        string? branch,
        string? defaultBranch,
        CancellationToken cancellationToken = default)
    {
        if (!string.IsNullOrEmpty(branch) && !BranchMatches(localDefault: defaultBranch, branch))
        {
            throw new FileNotFoundException("Branch not found", relativePath);
        }

        var rel = relativePath.Replace('\\', '/');
        if (!TryValidateVirtualPath(rel, out var message))
        {
            throw new ArgumentException(message);
        }

        var root = GetRepositoryRoot(repositoryId);
        var full = Path.GetFullPath(Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar)));
        AssertPathWithinRoot(root, full);
        if (!File.Exists(full))
        {
            throw new FileNotFoundException("File not found", relativePath);
        }

        var length = new FileInfo(full).Length;
        if (length == 0)
        {
            return new RepositoryFileContentDto
            {
                Name = Path.GetFileName(full),
                Path = rel,
                Content = string.Empty,
                Encoding = "utf-8",
                Size = 0,
                Sha = null,
                Language = null,
                IsBinary = false,
                IsTruncated = false
            };
        }

        const int maxDisplay = 1_000_000;
        var peekSize = (int)Math.Min(length, 8192);
        var peek = new byte[peekSize];
        await using (var stream = new FileStream(
            full,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            4096,
            FileOptions.Asynchronous))
        {
            var n = await stream.ReadAsync(peek.AsMemory(0, peekSize), cancellationToken).ConfigureAwait(false);
            if (peek.AsSpan(0, n).IndexOf((byte)0) >= 0)
            {
                return new RepositoryFileContentDto
                {
                    Name = Path.GetFileName(full),
                    Path = rel,
                    Content = "[Binary file - cannot display]",
                    Encoding = "utf-8",
                    Size = length,
                    Sha = null,
                    Language = null,
                    IsBinary = true,
                    IsTruncated = length > maxDisplay
                };
            }
        }

        var text = await File.ReadAllTextAsync(full, Encoding.UTF8, cancellationToken).ConfigureAwait(false);
        var isTruncated = false;
        if (text.Length > maxDisplay)
        {
            text = string.Concat(text.AsSpan(0, maxDisplay), "…[truncated]");
            isTruncated = true;
        }

        return new RepositoryFileContentDto
        {
            Name = Path.GetFileName(full),
            Path = rel,
            Content = text,
            Encoding = "utf-8",
            Size = length,
            Sha = null,
            Language = null,
            IsBinary = false,
            IsTruncated = isTruncated
        };
    }

    public IReadOnlyList<RepositoryBranchDto> GetBranches(string? defaultBranch)
    {
        var b = string.IsNullOrEmpty(defaultBranch) ? DefaultVirtualBranch : defaultBranch;
        return
        [
            new RepositoryBranchDto
            {
                Name = b,
                Sha = "local",
                IsDefault = true,
                IsProtected = false
            }
        ];
    }

    public async Task WriteTextFileAsync(
        Guid repositoryId,
        string relativePath,
        string utf8Text,
        CancellationToken cancellationToken = default)
    {
        var rel = relativePath.Replace('\\', '/').Trim();
        if (!TryValidateVirtualPath(rel, out var message))
        {
            throw new ArgumentException(message);
        }

        var root = GetRepositoryRoot(repositoryId);
        Directory.CreateDirectory(root);
        var full = Path.GetFullPath(Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar)));
        AssertPathWithinRoot(root, full);
        var dir = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        await File.WriteAllTextAsync(
                full,
                utf8Text,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
                cancellationToken)
            .ConfigureAwait(false);
    }

    private static bool BranchMatches(string? localDefault, string? requested)
    {
        var d = string.IsNullOrEmpty(localDefault) ? DefaultVirtualBranch : localDefault;
        if (string.IsNullOrEmpty(requested))
        {
            return true;
        }

        return string.Equals(d, requested, StringComparison.OrdinalIgnoreCase);
    }

    private static string? NormalizeKey(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        return path.Replace('\\', '/').Trim().TrimStart('/');
    }

    private static string ToVirtualPath(string root, string fileFull)
    {
        if (!fileFull.StartsWith(root, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Invalid file path under repository");
        }

        var rel = fileFull.Substring(root.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return rel.Replace(Path.DirectorySeparatorChar, '/').Replace(Path.AltDirectorySeparatorChar, '/');
    }

    private static bool TryValidateVirtualPath(string path, out string? error)
    {
        if (string.IsNullOrEmpty(path) || path.EndsWith('/'))
        {
            error = "A file path is required";
            return false;
        }

        if (path.Contains("..", StringComparison.Ordinal))
        {
            error = "Invalid path";
            return false;
        }

        if (Path.IsPathRooted(path))
        {
            error = "Invalid path";
            return false;
        }

        error = null;
        return true;
    }

    public async Task<Stream> OpenArchiveAsZipStreamAsync(Guid repositoryId, CancellationToken cancellationToken = default)
    {
        var root = GetRepositoryRoot(repositoryId);
        if (!Directory.Exists(root))
        {
            Directory.CreateDirectory(root);
        }

        var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(root, file);
                var relPosix = rel.Replace('\\', '/');
                if (relPosix.Contains("/.git/", StringComparison.Ordinal) || relPosix.StartsWith(".git/", StringComparison.Ordinal))
                {
                    continue;
                }

                var entry = zip.CreateEntry(relPosix, CompressionLevel.Fastest);
                await using var es = entry.Open();
                await using var fs = new FileStream(
                    file,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read,
                    bufferSize: 4096,
                    FileOptions.Asynchronous);
                await fs.CopyToAsync(es, cancellationToken).ConfigureAwait(false);
            }
        }

        ms.Position = 0;
        return ms;
    }

    public async Task ReplaceTreeFromZipAsync(Guid repositoryId, Stream zipStream, CancellationToken cancellationToken = default)
    {
        var root = GetRepositoryRoot(repositoryId);
        if (Directory.Exists(root))
        {
            Directory.Delete(root, true);
        }

        Directory.CreateDirectory(root);
        var rootFull = Path.GetFullPath(root);

        using var zip = new ZipArchive(zipStream, ZipArchiveMode.Read, leaveOpen: true);
        foreach (var entry in zip.Entries)
        {
            var name = entry.FullName.Replace('\\', '/').Trim();
            if (string.IsNullOrEmpty(name))
            {
                continue;
            }

            if (name.Contains("..", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Invalid path in zip");
            }

            var destPath = Path.GetFullPath(Path.Combine(root, name.Replace('/', Path.DirectorySeparatorChar)));
            if (!destPath.StartsWith(rootFull, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Zip path escapes repository root");
            }

            if (name.EndsWith('/') || string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(destPath);
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(destPath) ?? root);
            await using (var ef = entry.Open())
            {
                await using var df = new FileStream(
                    destPath,
                    FileMode.Create,
                    FileAccess.Write,
                    FileShare.None,
                    4096,
                    FileOptions.Asynchronous);
                await ef.CopyToAsync(df, cancellationToken).ConfigureAwait(false);
            }
        }
    }

}
