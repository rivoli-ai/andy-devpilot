namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;

/// <summary>
/// In-memory implementation of IUserRepository for development/testing
/// Will be replaced with EF Core implementation later
/// </summary>
public class InMemoryUserRepository : IUserRepository
{
    private readonly Dictionary<Guid, User> _users = new();
    private readonly Dictionary<string, User> _usersByEmail = new(StringComparer.OrdinalIgnoreCase);

    public System.Threading.Tasks.Task<User?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default)
    {
        _users.TryGetValue(id, out var user);
        return System.Threading.Tasks.Task.FromResult<User?>(user);
    }

    public System.Threading.Tasks.Task<User?> GetByEmailAsync(string email, CancellationToken cancellationToken = default)
    {
        _usersByEmail.TryGetValue(email, out var user);
        return System.Threading.Tasks.Task.FromResult<User?>(user);
    }

    public System.Threading.Tasks.Task<User> AddAsync(User user, CancellationToken cancellationToken = default)
    {
        _users[user.Id] = user;
        _usersByEmail[user.Email] = user;
        return System.Threading.Tasks.Task.FromResult(user);
    }

    public System.Threading.Tasks.Task UpdateAsync(User user, CancellationToken cancellationToken = default)
    {
        if (_users.ContainsKey(user.Id))
        {
            _users[user.Id] = user;
            // Update email index if email changed
            var oldEmail = _usersByEmail.FirstOrDefault(kvp => kvp.Value.Id == user.Id).Key;
            if (oldEmail != null && oldEmail != user.Email)
            {
                _usersByEmail.Remove(oldEmail);
            }
            _usersByEmail[user.Email] = user;
        }
        return System.Threading.Tasks.Task.CompletedTask;
    }
}
