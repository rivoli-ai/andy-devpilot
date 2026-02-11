namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

/// <summary>
/// Repository interface for FileAnalysis entity
/// </summary>
public interface IFileAnalysisRepository
{
    System.Threading.Tasks.Task<FileAnalysis?> GetByRepositoryAndPathAsync(Guid repositoryId, string filePath, string? branch = null, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<IEnumerable<FileAnalysis>> GetByRepositoryIdAsync(Guid repositoryId, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<FileAnalysis> AddAsync(FileAnalysis analysis, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(FileAnalysis analysis, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteByRepositoryIdAsync(Guid repositoryId, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteByRepositoryAndPathAsync(Guid repositoryId, string filePath, CancellationToken cancellationToken = default);
}
