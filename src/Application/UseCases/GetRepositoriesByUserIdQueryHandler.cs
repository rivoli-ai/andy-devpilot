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

    public GetRepositoriesByUserIdQueryHandler(IRepositoryRepository repositoryRepository)
    {
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
    }

    public async Task<IEnumerable<RepositoryDto>> Handle(
        GetRepositoriesByUserIdQuery request,
        CancellationToken cancellationToken)
    {
        var repositories = await _repositoryRepository.GetByUserIdAsync(request.UserId, cancellationToken);

        return repositories.Select(r => new RepositoryDto
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
        });
    }
}
