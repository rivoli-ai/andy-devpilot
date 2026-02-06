namespace DevPilot.Application.Queries;

using DevPilot.Application.DTOs;
using MediatR;

/// <summary>
/// Query to retrieve paginated repositories for a user with optional search
/// </summary>
public class GetRepositoriesPaginatedQuery : IRequest<PagedRepositoriesResult>
{
    public Guid UserId { get; }
    public string? Search { get; }
    public int Page { get; }
    public int PageSize { get; }

    public GetRepositoriesPaginatedQuery(Guid userId, string? search = null, int page = 1, int pageSize = 20)
    {
        UserId = userId;
        Search = search;
        Page = Math.Max(1, page);
        PageSize = Math.Clamp(pageSize, 1, 100);
    }
}

/// <summary>
/// Result of paginated repositories query
/// </summary>
public class PagedRepositoriesResult
{
    public IEnumerable<RepositoryDto> Items { get; set; } = new List<RepositoryDto>();
    public int TotalCount { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
    public int TotalPages => PageSize > 0 ? (int)Math.Ceiling((double)TotalCount / PageSize) : 0;
    public bool HasMore => Page < TotalPages;
}
