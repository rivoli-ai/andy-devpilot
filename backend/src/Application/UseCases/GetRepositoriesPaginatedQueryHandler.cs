namespace DevPilot.Application.UseCases;

using DevPilot.Application.DTOs;
using DevPilot.Application.Queries;
using DevPilot.Domain.Interfaces;
using MediatR;

/// <summary>
/// Handler for GetRepositoriesPaginatedQuery
/// </summary>
public class GetRepositoriesPaginatedQueryHandler : IRequestHandler<GetRepositoriesPaginatedQuery, PagedRepositoriesResult>
{
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IRepositoryShareRepository _repositoryShareRepository;
    private readonly IUserRepository _userRepository;

    public GetRepositoriesPaginatedQueryHandler(
        IRepositoryRepository repositoryRepository,
        IRepositoryShareRepository repositoryShareRepository,
        IUserRepository userRepository)
    {
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _repositoryShareRepository = repositoryShareRepository ?? throw new ArgumentNullException(nameof(repositoryShareRepository));
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
    }

    public async Task<PagedRepositoriesResult> Handle(
        GetRepositoriesPaginatedQuery request,
        CancellationToken cancellationToken)
    {
        var (items, totalCount) = await _repositoryRepository.GetAccessibleByUserIdPaginatedAsync(
            request.UserId,
            request.Search,
            request.Filter,
            request.Page,
            request.PageSize,
            cancellationToken);

        var itemsList = items.ToList();
        var ownedIds = itemsList.Where(r => r.UserId == request.UserId).Select(r => r.Id).ToList();
        var shareCounts = ownedIds.Count > 0
            ? await _repositoryShareRepository.GetSharedWithCountsByRepositoryIdsAsync(ownedIds, cancellationToken)
            : new Dictionary<Guid, int>();

        var ownerIds = itemsList.Where(r => r.UserId != request.UserId).Select(r => r.UserId).Distinct().ToList();
        var ownerMap = new Dictionary<Guid, (string? Name, string? Email)>();
        foreach (var ownerId in ownerIds)
        {
            var owner = await _userRepository.GetByIdAsync(ownerId, cancellationToken);
            if (owner != null)
                ownerMap[ownerId] = (owner.Name, owner.Email);
        }

        return new PagedRepositoriesResult
        {
            Items = itemsList.Select(r =>
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
                    LlmSettingId = r.LlmSettingId,
                    OwnerEmail = ownerEmail
                };
            }),
            TotalCount = totalCount,
            Page = request.Page,
            PageSize = request.PageSize
        };
    }
}
