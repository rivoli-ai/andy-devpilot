namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

public interface IGlobalAgentRuleRepository
{
    System.Threading.Tasks.Task<IReadOnlyList<GlobalAgentRule>> GetAllAsync(CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<GlobalAgentRule?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    /// <summary>Case-insensitive name match, excluding <paramref name="exceptId"/> when updating.</summary>
    System.Threading.Tasks.Task<bool> NameExistsAsync(string name, Guid? exceptId, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<GlobalAgentRule> AddAsync(GlobalAgentRule entity, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(
        Guid id,
        string name,
        string body,
        int sortOrder,
        CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default);
}
