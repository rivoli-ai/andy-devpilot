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

    public System.Threading.Tasks.Task<User?> GetByIdForUpdateAsync(Guid id, CancellationToken cancellationToken = default)
    {
        _users.TryGetValue(id, out var user);
        return System.Threading.Tasks.Task.FromResult<User?>(user);
    }

    public System.Threading.Tasks.Task<IReadOnlyList<User>> ListAllOrderedByEmailAsync(CancellationToken cancellationToken = default)
    {
        var list = _users.Values.OrderBy(u => u.Email).ToList();
        return System.Threading.Tasks.Task.FromResult<IReadOnlyList<User>>(list);
    }

    public System.Threading.Tasks.Task<User?> GetByEmailAsync(string email, CancellationToken cancellationToken = default)
    {
        _usersByEmail.TryGetValue(email, out var user);
        return System.Threading.Tasks.Task.FromResult<User?>(user);
    }

    public System.Threading.Tasks.Task<IReadOnlyList<User>> SearchSuggestionsAsync(string query, int limit, Guid? excludeUserId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(query) || limit <= 0)
            return System.Threading.Tasks.Task.FromResult<IReadOnlyList<User>>(Array.Empty<User>());
        var term = query.Trim().ToLowerInvariant();
        var matches = _users.Values
            .Where(u => (!excludeUserId.HasValue || u.Id != excludeUserId.Value)
                && ((u.Email != null && u.Email.ToLowerInvariant().Contains(term))
                    || (u.Name != null && u.Name.ToLowerInvariant().Contains(term))))
            .OrderBy(u => u.Email)
            .Take(limit)
            .ToList();
        return System.Threading.Tasks.Task.FromResult<IReadOnlyList<User>>(matches);
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
