namespace DevPilot.Application.Queries;

using DevPilot.Application.DTOs;
using MediatR;

/// <summary>
/// Query to retrieve all repositories for a specific user
/// </summary>
/// <summary>Filter for repository list: all, only mine, or only shared with me.</summary>
public static class RepositoryListFilter
{
    public const string All = "all";
    public const string Mine = "mine";
    public const string Shared = "shared";
}

public class GetRepositoriesByUserIdQuery : IRequest<IEnumerable<RepositoryDto>>
{
    public Guid UserId { get; }
    /// <summary>Optional: "all" | "mine" | "shared"</summary>
    public string? Filter { get; }

    public GetRepositoriesByUserIdQuery(Guid userId, string? filter = null)
    {
        UserId = userId;
        Filter = filter;
    }
}
