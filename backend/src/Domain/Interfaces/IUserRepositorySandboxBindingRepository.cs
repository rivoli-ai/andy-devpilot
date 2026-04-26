using System.Collections.Generic;
using DevPilot.Domain.Entities;
using Task = System.Threading.Tasks.Task;

namespace DevPilot.Domain.Interfaces;

public interface IUserRepositorySandboxBindingRepository
{
    Task<IReadOnlyList<UserRepositorySandboxBinding>> GetAllByUserIdAsync(
        Guid userId,
        CancellationToken cancellationToken = default);

    /// <param name="repoBranch">Same normalization as on create: trim, default to main if empty.</param>
    Task<UserRepositorySandboxBinding?> GetByUserRepositoryAndBranchAsync(
        Guid userId,
        Guid repositoryId,
        string repoBranch,
        CancellationToken cancellationToken = default);

    Task UpsertAsync(
        Guid userId,
        Guid repositoryId,
        string sandboxId,
        string repoBranch,
        CancellationToken cancellationToken = default);

    Task DeleteBySandboxIdAsync(string sandboxId, CancellationToken cancellationToken = default);
}
