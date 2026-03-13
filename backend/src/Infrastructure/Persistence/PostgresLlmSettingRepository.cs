namespace DevPilot.Infrastructure.Persistence;

using System.Threading;
using System.Threading.Tasks;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

public class PostgresLlmSettingRepository : ILlmSettingRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresLlmSettingRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async System.Threading.Tasks.Task<LlmSetting?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        return await _context.LlmSettings.FindAsync(new object[] { id }, cancellationToken);
    }

    public async System.Threading.Tasks.Task<IReadOnlyList<LlmSetting>> GetByUserIdAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        var list = await _context.LlmSettings
            .Where(s => s.UserId == userId)
            .OrderBy(s => s.IsDefault ? 0 : 1)
            .ThenBy(s => s.Name)
            .ToListAsync(cancellationToken);
        return list;
    }

    public async System.Threading.Tasks.Task<IReadOnlyList<LlmSetting>> GetSharedAsync(CancellationToken cancellationToken = default)
    {
        var list = await _context.LlmSettings
            .Where(s => s.UserId == null)
            .OrderBy(s => s.Name)
            .ToListAsync(cancellationToken);
        return list;
    }

    public System.Threading.Tasks.Task<LlmSetting?> GetDefaultByUserIdAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        return _context.LlmSettings
            .FirstOrDefaultAsync(s => s.UserId == userId && s.IsDefault, cancellationToken);
    }

    public async System.Threading.Tasks.Task<LlmSetting> AddAsync(LlmSetting entity, CancellationToken cancellationToken = default)
    {
        if (entity.IsDefault && entity.UserId.HasValue)
            await UnsetDefaultForUserAsync(entity.UserId.Value, cancellationToken).ConfigureAwait(false);
        await _context.LlmSettings.AddAsync(entity, cancellationToken).ConfigureAwait(false);
        await _context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return entity;
    }

    public async System.Threading.Tasks.Task UpdateAsync(LlmSetting entity, CancellationToken cancellationToken = default)
    {
        if (entity.IsDefault && entity.UserId.HasValue)
            await UnsetDefaultForUserAsync(entity.UserId.Value, cancellationToken).ConfigureAwait(false);
        _context.LlmSettings.Update(entity);
        await _context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    public async System.Threading.Tasks.Task DeleteAsync(Guid id, CancellationToken cancellationToken = default)
    {
        var entity = await _context.LlmSettings.FindAsync(new object[] { id }, cancellationToken);
        if (entity != null)
        {
            _context.LlmSettings.Remove(entity);
            await _context.SaveChangesAsync(cancellationToken);
        }
    }

    public async System.Threading.Tasks.Task UnsetDefaultForUserAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        var defaults = await _context.LlmSettings
            .Where(s => s.UserId == userId && s.IsDefault)
            .ToListAsync(cancellationToken);
        foreach (var s in defaults)
            s.SetDefault(false);
        if (defaults.Count > 0)
            await _context.SaveChangesAsync(cancellationToken);
    }
}
