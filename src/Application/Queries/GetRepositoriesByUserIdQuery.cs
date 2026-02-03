namespace DevPilot.Application.Queries;

using DevPilot.Application.DTOs;
using MediatR;

/// <summary>
/// Query to retrieve all repositories for a specific user
/// </summary>
public class GetRepositoriesByUserIdQuery : IRequest<IEnumerable<RepositoryDto>>
{
    public Guid UserId { get; }

    public GetRepositoriesByUserIdQuery(Guid userId)
    {
        UserId = userId;
    }
}
