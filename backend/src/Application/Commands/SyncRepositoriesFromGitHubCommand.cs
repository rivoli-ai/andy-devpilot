namespace DevPilot.Application.Commands;

using DevPilot.Application.DTOs;
using MediatR;

/// <summary>
/// Command to fetch repositories from GitHub and sync them to the database
/// </summary>
public class SyncRepositoriesFromGitHubCommand : IRequest<IEnumerable<RepositoryDto>>
{
    public Guid UserId { get; }
    public string AccessToken { get; }

    public SyncRepositoriesFromGitHubCommand(Guid userId, string accessToken)
    {
        UserId = userId;
        AccessToken = accessToken ?? throw new ArgumentNullException(nameof(accessToken));
    }
}
