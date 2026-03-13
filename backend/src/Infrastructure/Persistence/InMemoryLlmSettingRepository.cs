namespace DevPilot.Infrastructure.Persistence;

using System.Threading;
using System.Threading.Tasks;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;

public class InMemoryLlmSettingRepository : ILlmSettingRepository
{
    private static readonly List<LlmSetting> Store = new();

    public System.Threading.Tasks.Task<LlmSetting?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return System.Threading.Tasks.Task.FromResult(Store.FirstOrDefault(s => s.Id == id));
    }

    public System.Threading.Tasks.Task<IReadOnlyList<LlmSetting>> GetByUserIdAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        var list = Store.Where(s => s.UserId == userId)
            .OrderBy(s => s.IsDefault ? 0 : 1)
            .ThenBy(s => s.Name)
            .ToList();
        return System.Threading.Tasks.Task.FromResult<IReadOnlyList<LlmSetting>>(list);
    }

    public System.Threading.Tasks.Task<IReadOnlyList<LlmSetting>> GetSharedAsync(CancellationToken cancellationToken = default)
    {
        var list = Store.Where(s => s.UserId == null).OrderBy(s => s.Name).ToList();
        return System.Threading.Tasks.Task.FromResult<IReadOnlyList<LlmSetting>>(list);
    }

    public System.Threading.Tasks.Task<LlmSetting?> GetDefaultByUserIdAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        return System.Threading.Tasks.Task.FromResult(Store.FirstOrDefault(s => s.UserId == userId && s.IsDefault));
    }

    public System.Threading.Tasks.Task<LlmSetting> AddAsync(LlmSetting entity, CancellationToken cancellationToken = default)
    {
        if (entity.IsDefault && entity.UserId.HasValue)
            UnsetDefaultForUserAsync(entity.UserId.Value, cancellationToken).GetAwaiter().GetResult();
        Store.Add(entity);
        return System.Threading.Tasks.Task.FromResult(entity);
    }

    public System.Threading.Tasks.Task UpdateAsync(LlmSetting entity, CancellationToken cancellationToken = default)
    {
        if (entity.IsDefault && entity.UserId.HasValue)
            UnsetDefaultForUserAsync(entity.UserId.Value, cancellationToken).GetAwaiter().GetResult();
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default)
    {
        var idx = Store.FindIndex(s => s.Id == id);
        if (idx >= 0) Store.RemoveAt(idx);
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public System.Threading.Tasks.Task UnsetDefaultForUserAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        foreach (var s in Store.Where(s => s.UserId == userId && s.IsDefault))
            s.SetDefault(false);
        return System.Threading.Tasks.Task.CompletedTask;
    }
}
