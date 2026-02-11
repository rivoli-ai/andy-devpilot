namespace DevPilot.Application.UseCases;

using DevPilot.Application.Commands;
using DevPilot.Application.DTOs;
using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

/// <summary>
/// Handler for SyncRepositoriesFromGitHubCommand
/// Fetches repositories from GitHub and syncs them to the database
/// </summary>
public class SyncRepositoriesFromGitHubCommandHandler : IRequestHandler<SyncRepositoriesFromGitHubCommand, IEnumerable<RepositoryDto>>
{
    private readonly IGitHubService _gitHubService;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly ILogger<SyncRepositoriesFromGitHubCommandHandler> _logger;

    public SyncRepositoriesFromGitHubCommandHandler(
        IGitHubService gitHubService,
        IRepositoryRepository repositoryRepository,
        ILogger<SyncRepositoriesFromGitHubCommandHandler> logger)
    {
        _gitHubService = gitHubService ?? throw new ArgumentNullException(nameof(gitHubService));
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<IEnumerable<RepositoryDto>> Handle(
        SyncRepositoriesFromGitHubCommand request,
        CancellationToken cancellationToken)
    {
        // Fetch repositories from GitHub
        var gitHubRepos = await _gitHubService.GetRepositoriesAsync(request.AccessToken, cancellationToken);

        var syncedRepositories = new List<RepositoryDto>();

        foreach (var gitHubRepo in gitHubRepos)
        {
            // Check if repository already exists in database
            var existingRepos = await _repositoryRepository.GetByUserIdAsync(request.UserId, cancellationToken);
            var existingRepo = existingRepos.FirstOrDefault(r => 
                r.FullName == gitHubRepo.FullName && r.Provider == "GitHub");

            if (existingRepo != null)
            {
                // Update existing repository
                existingRepo.UpdateDescription(gitHubRepo.Description);
                existingRepo.UpdateDefaultBranch(gitHubRepo.DefaultBranch);
                await _repositoryRepository.UpdateAsync(existingRepo, cancellationToken);

                syncedRepositories.Add(MapToDto(existingRepo));
            }
            else
            {
                // Create new repository
                var newRepo = new Repository(
                    name: gitHubRepo.Name,
                    fullName: gitHubRepo.FullName,
                    cloneUrl: gitHubRepo.CloneUrl,
                    provider: "GitHub",
                    organizationName: gitHubRepo.OrganizationName,
                    userId: request.UserId,
                    description: gitHubRepo.Description,
                    isPrivate: gitHubRepo.IsPrivate,
                    defaultBranch: gitHubRepo.DefaultBranch);

                await _repositoryRepository.AddAsync(newRepo, cancellationToken);

                syncedRepositories.Add(MapToDto(newRepo));
            }
        }

        _logger.LogInformation("Synced {Count} repositories from GitHub for user {UserId}", 
            syncedRepositories.Count, request.UserId);

        return syncedRepositories;
    }

    private RepositoryDto MapToDto(Repository repository)
    {
        return new RepositoryDto
        {
            Id = repository.Id,
            Name = repository.Name,
            FullName = repository.FullName,
            CloneUrl = repository.CloneUrl,
            Description = repository.Description,
            IsPrivate = repository.IsPrivate,
            Provider = repository.Provider,
            OrganizationName = repository.OrganizationName,
            DefaultBranch = repository.DefaultBranch,
            CreatedAt = repository.CreatedAt,
            UpdatedAt = repository.UpdatedAt
        };
    }
}
