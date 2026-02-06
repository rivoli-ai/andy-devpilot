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

    public GetRepositoriesPaginatedQueryHandler(IRepositoryRepository repositoryRepository)
    {
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
    }

    public async Task<PagedRepositoriesResult> Handle(
        GetRepositoriesPaginatedQuery request,
        CancellationToken cancellationToken)
    {
        var (items, totalCount) = await _repositoryRepository.GetByUserIdPaginatedAsync(
            request.UserId,
            request.Search,
            request.Page,
            request.PageSize,
            cancellationToken);

        return new PagedRepositoriesResult
        {
            Items = items.Select(r => new RepositoryDto
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
                UpdatedAt = r.UpdatedAt
            }),
            TotalCount = totalCount,
            Page = request.Page,
            PageSize = request.PageSize
        };
    }
}
