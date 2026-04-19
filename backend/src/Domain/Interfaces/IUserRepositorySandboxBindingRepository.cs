using DevPilot.Domain.Entities;
using Task = System.Threading.Tasks.Task;

namespace DevPilot.Domain.Interfaces;

public interface IUserRepositorySandboxBindingRepository
{
    Task<UserRepositorySandboxBinding?> GetByUserAndRepositoryAsync(
        Guid userId,
        Guid repositoryId,
        CancellationToken cancellationToken = default);

    Task UpsertAsync(
        Guid userId,
        Guid repositoryId,
        string sandboxId,
        string repoBranch,
        CancellationToken cancellationToken = default);

    Task DeleteBySandboxIdAsync(string sandboxId, CancellationToken cancellationToken = default);
}
