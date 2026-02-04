namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

/// <summary>
/// Repository interface for CodeAnalysis entity
/// </summary>
public interface ICodeAnalysisRepository
{
    System.Threading.Tasks.Task<CodeAnalysis?> GetByRepositoryIdAsync(Guid repositoryId, string? branch = null, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<CodeAnalysis> AddAsync(CodeAnalysis analysis, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(CodeAnalysis analysis, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteByRepositoryIdAsync(Guid repositoryId, CancellationToken cancellationToken = default);
}
