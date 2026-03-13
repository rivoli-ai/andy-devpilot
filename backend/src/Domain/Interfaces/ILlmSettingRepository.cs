namespace DevPilot.Domain.Interfaces;

using System.Threading;
using System.Threading.Tasks;
using DevPilot.Domain.Entities;

public interface ILlmSettingRepository
{
    Task<LlmSetting?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    /// <summary>Returns the user's personal LLM settings only.</summary>
    Task<IReadOnlyList<LlmSetting>> GetByUserIdAsync(Guid userId, CancellationToken cancellationToken = default);
    /// <summary>Returns all shared (admin-created) LLM settings visible to every user.</summary>
    Task<IReadOnlyList<LlmSetting>> GetSharedAsync(CancellationToken cancellationToken = default);
    Task<LlmSetting?> GetDefaultByUserIdAsync(Guid userId, CancellationToken cancellationToken = default);
    Task<LlmSetting> AddAsync(LlmSetting entity, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(LlmSetting entity, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UnsetDefaultForUserAsync(Guid userId, CancellationToken cancellationToken = default);
}
