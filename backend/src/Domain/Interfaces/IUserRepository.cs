namespace DevPilot.Domain.Interfaces;

using DevPilot.Domain.Entities;

/// <summary>
/// Repository interface for User entity
/// </summary>
public interface IUserRepository
{
    System.Threading.Tasks.Task<User?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<User?> GetByEmailAsync(string email, CancellationToken cancellationToken = default);
    /// <summary>Search users by email or name for suggestions (e.g. when sharing a repository).</summary>
    System.Threading.Tasks.Task<IReadOnlyList<User>> SearchSuggestionsAsync(string query, int limit, Guid? excludeUserId, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task<User> AddAsync(User user, CancellationToken cancellationToken = default);
    System.Threading.Tasks.Task UpdateAsync(User user, CancellationToken cancellationToken = default);
}
