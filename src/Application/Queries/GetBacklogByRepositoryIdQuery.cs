namespace DevPilot.Application.Queries;

using DevPilot.Application.DTOs;
using MediatR;

/// <summary>
/// Query to retrieve the complete backlog (Epics, Features, User Stories) for a repository
/// </summary>
public class GetBacklogByRepositoryIdQuery : IRequest<IEnumerable<EpicDto>>
{
    public Guid RepositoryId { get; }

    public GetBacklogByRepositoryIdQuery(Guid repositoryId)
    {
        RepositoryId = repositoryId;
    }
}
