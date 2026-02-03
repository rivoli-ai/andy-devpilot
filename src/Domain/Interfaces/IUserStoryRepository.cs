namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

/// <summary>
/// Repository interface for UserStory entity
/// </summary>
public interface IUserStoryRepository
{
    System.Threading.Tasks.Task<UserStory?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<UserStory> AddAsync(UserStory userStory, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(UserStory userStory, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task DeleteAsync(UserStory userStory, CancellationToken cancellationToken = default);
}
