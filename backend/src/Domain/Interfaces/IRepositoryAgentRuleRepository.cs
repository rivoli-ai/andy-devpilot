namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

public interface IRepositoryAgentRuleRepository
{
    System.Threading.Tasks.Task<IReadOnlyList<RepositoryAgentRule>> GetByRepositoryIdAsync(
        Guid repositoryId,
        CancellationToken cancellationToken = default);

    System.Threading.Tasks.Task<RepositoryAgentRule?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);

    /// <summary>Replace all rules for a repository (upsert by id, remove missing, null story FKs for deleted).</summary>
    System.Threading.Tasks.Task ReplaceForRepositoryAsync(
        Guid repositoryId,
        IReadOnlyList<(Guid? Id, string Name, string Body, bool IsDefault, int SortOrder)> items,
        CancellationToken cancellationToken = default);
}
