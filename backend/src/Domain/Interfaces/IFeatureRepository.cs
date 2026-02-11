namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

/// <summary>
/// Repository interface for Feature entity
/// </summary>
public interface IFeatureRepository
{
    System.Threading.Tasks.Task<Feature?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<Feature> AddAsync(Feature feature, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(Feature feature, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteAsync(Feature feature, CancellationToken cancellationToken = default);
}
