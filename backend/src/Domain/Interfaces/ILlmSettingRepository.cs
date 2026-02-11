namespace DevPilot.Domain.Interfaces;

using System.Threading;
using System.Threading.Tasks;
using DevPilot.Domain.Entities;

public interface ILlmSettingRepository
{
    Task<LlmSetting?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<LlmSetting>> GetByUserIdAsync(Guid userId, CancellationToken cancellationToken = default);
    Task<LlmSetting?> GetDefaultByUserIdAsync(Guid userId, CancellationToken cancellationToken = default);
    Task<LlmSetting> AddAsync(LlmSetting entity, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(LlmSetting entity, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UnsetDefaultForUserAsync(Guid userId, CancellationToken cancellationToken = default);
}
