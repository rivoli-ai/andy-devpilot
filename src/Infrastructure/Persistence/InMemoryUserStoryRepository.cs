namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;

/// <summary>
/// In-memory implementation of IUserStoryRepository for development/testing
/// </summary>
public class InMemoryUserStoryRepository : IUserStoryRepository
{
    private readonly Dictionary<Guid, UserStory> _userStories = new();

    public System.Threading.Tasks.Task<UserStory?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        _userStories.TryGetValue(id, out var userStory);
        return System.Threading.Tasks.Task.FromResult<UserStory?>(userStory);
    }

    public System.Threading.Tasks.Task<UserStory> AddAsync(UserStory userStory, CancellationToken cancellationToken = default)
    {
        _userStories[userStory.Id] = userStory;
        return System.Threading.Tasks.Task.FromResult(userStory);
    }

    public System.Threading.Tasks.Task UpdateAsync(UserStory userStory, CancellationToken cancellationToken = default)
    {
        if (_userStories.ContainsKey(userStory.Id))
        {
            _userStories[userStory.Id] = userStory;
        }
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public System.Threading.Tasks.Task DeleteAsync(UserStory userStory, CancellationToken cancellationToken = default)
    {
        _userStories.Remove(userStory.Id);
        return System.Threading.Tasks.Task.CompletedTask;
    }
}
