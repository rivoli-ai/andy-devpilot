namespace DevPilot.Application.UseCases;

using DevPilot.Application.DTOs;
using DevPilot.Application.Queries;
using DevPilot.Domain.Interfaces;
using MediatR;

/// <summary>
/// Handler for GetRepositoriesByUserIdQuery
/// Implements CQRS pattern - separates read operations from write operations
/// </summary>
public class GetRepositoriesByUserIdQueryHandler : IRequestHandler<GetRepositoriesByUserIdQuery, IEnumerable<RepositoryDto>>
{
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IRepositoryShareRepository _repositoryShareRepository;
    private readonly IUserRepository _userRepository;

    public GetRepositoriesByUserIdQueryHandler(
        IRepositoryRepository repositoryRepository,
        IRepositoryShareRepository repositoryShareRepository,
        IUserRepository userRepository)
    {
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _repositoryShareRepository = repositoryShareRepository ?? throw new ArgumentNullException(nameof(repositoryShareRepository));
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
    }

    public async Task<IEnumerable<RepositoryDto>> Handle(
        GetRepositoriesByUserIdQuery request,
        CancellationToken cancellationToken)
    {
        var repositories = (await _repositoryRepository.GetAccessibleByUserIdAsync(request.UserId, cancellationToken)).ToList();

        // Apply visibility filter
        if (string.Equals(request.Filter, "mine", StringComparison.OrdinalIgnoreCase))
            repositories = repositories.Where(r => r.UserId == request.UserId).ToList();
        else if (string.Equals(request.Filter, "shared", StringComparison.OrdinalIgnoreCase))
            repositories = repositories.Where(r => r.UserId != request.UserId).ToList();

        var ownedIds = repositories.Where(r => r.UserId == request.UserId).Select(r => r.Id).ToList();
        var shareCounts = ownedIds.Count > 0
            ? await _repositoryShareRepository.GetSharedWithCountsByRepositoryIdsAsync(ownedIds, cancellationToken)
            : new Dictionary<Guid, int>();

        // Load owner info for shared repos (person who shared with you)
        var ownerIds = repositories.Where(r => r.UserId != request.UserId).Select(r => r.UserId).Distinct().ToList();
        var ownerMap = new Dictionary<Guid, (string? Name, string? Email)>();
        foreach (var ownerId in ownerIds)
        {
            var owner = await _userRepository.GetByIdAsync(ownerId, cancellationToken);
            if (owner != null)
                ownerMap[ownerId] = (owner.Name, owner.Email);
        }

        return repositories.Select(r =>
        {
            var isOwner = r.UserId == request.UserId;
            var (ownerName, ownerEmail) = !isOwner && ownerMap.TryGetValue(r.UserId, out var o) ? o : ((string?)null, (string?)null);
            return new RepositoryDto
            {
                Id = r.Id,
                Name = r.Name,
                FullName = r.FullName,
                CloneUrl = r.CloneUrl,
                Description = r.Description,
                IsPrivate = r.IsPrivate,
                Provider = r.Provider,
                OrganizationName = r.OrganizationName,
                DefaultBranch = r.DefaultBranch,
                CreatedAt = r.CreatedAt,
                UpdatedAt = r.UpdatedAt,
                IsOwner = isOwner,
                SharedWithCount = isOwner && shareCounts.TryGetValue(r.Id, out var count) ? count : 0,
                OwnerName = ownerName,
                OwnerEmail = ownerEmail
            };
        });
    }
}
