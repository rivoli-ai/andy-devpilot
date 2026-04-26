using System.Text.RegularExpressions;
using DevPilot.Application.DTOs;
using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;
using static DevPilot.Domain.Entities.ProviderTypes;

namespace DevPilot.Application.UseCases;

public record CreateUnpublishedRepositoryCommand(Guid UserId, string Name, string? Description)
    : IRequest<RepositoryDto>;

public record PublishUnpublishedToGitHubCommand(
    Guid UserId,
    Guid RepositoryId,
    string RepositoryName,
    string? Description,
    bool IsPrivate,
    string? OrganizationLogin)
    : IRequest<RepositoryDto>;

public record PublishUnpublishedToAzureCommand(
    Guid UserId,
    Guid RepositoryId,
    string Organization,
    string Project,
    string RepositoryName,
    string? ReadmeOverride)
    : IRequest<RepositoryDto>;

public class CreateUnpublishedRepositoryCommandHandler
    : IRequestHandler<CreateUnpublishedRepositoryCommand, RepositoryDto>
{
    private const string UnpublishedProvider = "Unpublished";
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IRepositoryShareRepository _repositoryShareRepository;
    private readonly IMediator _mediator;
    private readonly IUnpublishedRepositoryFileStore _unpublishedFileStore;
    private readonly ILogger<CreateUnpublishedRepositoryCommandHandler> _logger;

    public CreateUnpublishedRepositoryCommandHandler(
        IRepositoryRepository repositoryRepository,
        IRepositoryShareRepository repositoryShareRepository,
        IMediator mediator,
        IUnpublishedRepositoryFileStore unpublishedFileStore,
        ILogger<CreateUnpublishedRepositoryCommandHandler> logger)
    {
        _repositoryRepository = repositoryRepository;
        _repositoryShareRepository = repositoryShareRepository;
        _mediator = mediator;
        _unpublishedFileStore = unpublishedFileStore;
        _logger = logger;
    }

    public async Task<RepositoryDto> Handle(
        CreateUnpublishedRepositoryCommand request,
        CancellationToken cancellationToken)
    {
        var name = (request.Name ?? string.Empty).Trim();
        if (name.Length is < 1 or > 200)
            throw new ArgumentException("Name must be between 1 and 200 characters.", nameof(request.Name));

        var repo = new Repository(
            name: name,
            fullName: "unpublished/pending",
            cloneUrl: "https://unpublished.local/pending",
            provider: UnpublishedProvider,
            organizationName: "Unpublished",
            userId: request.UserId,
            description: string.IsNullOrWhiteSpace(request.Description) ? null : request.Description.Trim(),
            isPrivate: false,
            defaultBranch: "main");

        await _repositoryRepository.AddAsync(repo, cancellationToken);

        var slug = Slugify(name);
        if (string.IsNullOrEmpty(slug)) slug = "project";
        var fullName = $"unpublished/{slug}-{repo.Id.ToString("N")[..8]}";
        var cloneUrl = $"https://unpublished.local/{repo.Id}";
        repo.SetUnpublishedLocalIdentity(fullName, cloneUrl);
        await _repositoryRepository.UpdateAsync(repo, cancellationToken);

        var backlog = new CreateBacklogRequest
        {
            ReplaceExisting = false,
            Epics = new List<CreateEpicRequest>
            {
                new()
                {
                    Title = "Product backlog",
                    Description = "Plan and track work for this project.",
                    Source = "Manual",
                    Features = new List<CreateFeatureRequest>
                    {
                        new()
                        {
                            Title = "Getting started",
                            Description = "Break work into user stories, then open the sandbox to implement them.",
                            Source = "Manual",
                            UserStories = new List<CreateUserStoryRequest>
                            {
                                new()
                                {
                                    Title = "Define your first user stories",
                                    Description = "Add features and stories, then use Backlog to sync to GitHub or Azure DevOps when you publish the repo.",
                                    Source = "Manual",
                                    AcceptanceCriteria = new List<string>()
                                }
                            }
                        }
                    }
                }
            }
        };

        await _mediator.Send(new CreateBacklogCommand(repo.Id, backlog), cancellationToken);

        await _unpublishedFileStore.EnsureSeededAsync(repo.Id, repo.Name, repo.Description, cancellationToken);

        _logger.LogInformation("Created unpublished repository {Id} {FullName} for user {UserId}", repo.Id, fullName, request.UserId);

        return await ToDtoAsync(repo, request.UserId, cancellationToken);
    }

    private static string Slugify(string s)
    {
        s = s.Trim().ToLowerInvariant();
        s = Regex.Replace(s, @"[^a-z0-9]+", "-", RegexOptions.Compiled);
        s = Regex.Replace(s, @"^-+|-+$", "", RegexOptions.Compiled);
        return s.Length > 40 ? s[..40].TrimEnd('-') : s;
    }

    private async Task<RepositoryDto> ToDtoAsync(Repository r, Guid userId, CancellationToken cancellationToken)
    {
        var count = await _repositoryShareRepository.GetSharedWithCountsByRepositoryIdsAsync(
            new List<Guid> { r.Id },
            cancellationToken);
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
            IsOwner = true,
            SharedWithCount = count.GetValueOrDefault(r.Id, 0),
        };
    }
}

public class PublishUnpublishedToGitHubCommandHandler
    : IRequestHandler<PublishUnpublishedToGitHubCommand, RepositoryDto>
{
    private const string Unpublished = "Unpublished";
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IRepositoryShareRepository _repositoryShareRepository;
    private readonly ILinkedProviderRepository _linkedProviderRepository;
    private readonly IUserRepository _userRepository;
    private readonly IGitHubService _gitHub;
    private readonly ILogger<PublishUnpublishedToGitHubCommandHandler> _logger;

    public PublishUnpublishedToGitHubCommandHandler(
        IRepositoryRepository repositoryRepository,
        IRepositoryShareRepository repositoryShareRepository,
        ILinkedProviderRepository linkedProviderRepository,
        IUserRepository userRepository,
        IGitHubService gitHub,
        ILogger<PublishUnpublishedToGitHubCommandHandler> logger)
    {
        _repositoryRepository = repositoryRepository;
        _repositoryShareRepository = repositoryShareRepository;
        _linkedProviderRepository = linkedProviderRepository;
        _userRepository = userRepository;
        _gitHub = gitHub;
        _logger = logger;
    }

    public async Task<RepositoryDto> Handle(
        PublishUnpublishedToGitHubCommand request,
        CancellationToken cancellationToken)
    {
        var accessToken = await GetGitHubTokenAsync(request.UserId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
            throw new InvalidOperationException("Connect GitHub or add a PAT in Settings to publish.");

        var repo = await _repositoryRepository.GetByIdIfAccessibleAsync(request.RepositoryId, request.UserId, cancellationToken);
        if (repo == null)
            throw new InvalidOperationException("Repository not found.");
        if (repo.UserId != request.UserId)
            throw new InvalidOperationException("Only the owner can publish.");
        if (repo.Provider != Unpublished)
            throw new InvalidOperationException("This repository is already published to a remote.");

        var repoName = (request.RepositoryName ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(repoName) || repoName.Length > 100)
            throw new ArgumentException("Valid GitHub repository name is required (1–100 characters).");

        var created = await _gitHub.CreateRepositoryAsync(
            accessToken,
            string.IsNullOrWhiteSpace(request.OrganizationLogin) ? null : request.OrganizationLogin.Trim(),
            repoName,
            string.IsNullOrWhiteSpace(request.Description) ? repo.Description : request.Description,
            request.IsPrivate,
            cancellationToken);

        repo.PromoteToPublishedRemote(
            name: created.Name,
            fullName: created.FullName,
            cloneUrl: created.CloneUrl,
            provider: "GitHub",
            organizationName: created.OrganizationName,
            isPrivate: created.IsPrivate,
            defaultBranch: created.DefaultBranch ?? "main");

        await _repositoryRepository.UpdateAsync(repo, cancellationToken);
        _logger.LogInformation("Published repository {Id} to GitHub as {FullName}", repo.Id, created.FullName);

        return await ToDtoAsync(repo, request.UserId, cancellationToken);
    }

    private async Task<string?> GetGitHubTokenAsync(Guid userId, CancellationToken cancellationToken)
    {
        var linked = await _linkedProviderRepository.GetByUserAndProviderAsync(
            userId, GitHub, cancellationToken);
        if (!string.IsNullOrEmpty(linked?.AccessToken)) return linked.AccessToken;
        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        return user?.GitHubAccessToken;
    }

    private async Task<RepositoryDto> ToDtoAsync(Repository r, Guid userId, CancellationToken cancellationToken)
    {
        var count = await _repositoryShareRepository.GetSharedWithCountsByRepositoryIdsAsync(
            new List<Guid> { r.Id },
            cancellationToken);
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
            IsOwner = true,
            SharedWithCount = count.GetValueOrDefault(r.Id, 0),
        };
    }
}

public class PublishUnpublishedToAzureCommandHandler
    : IRequestHandler<PublishUnpublishedToAzureCommand, RepositoryDto>
{
    private const string Unpublished = "Unpublished";
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IRepositoryShareRepository _repositoryShareRepository;
    private readonly ILinkedProviderRepository _linkedProviderRepository;
    private readonly IUserRepository _userRepository;
    private readonly IAzureDevOpsService _ado;
    private readonly ILogger<PublishUnpublishedToAzureCommandHandler> _logger;

    public PublishUnpublishedToAzureCommandHandler(
        IRepositoryRepository repositoryRepository,
        IRepositoryShareRepository repositoryShareRepository,
        ILinkedProviderRepository linkedProviderRepository,
        IUserRepository userRepository,
        IAzureDevOpsService ado,
        ILogger<PublishUnpublishedToAzureCommandHandler> logger)
    {
        _repositoryRepository = repositoryRepository;
        _repositoryShareRepository = repositoryShareRepository;
        _linkedProviderRepository = linkedProviderRepository;
        _userRepository = userRepository;
        _ado = ado;
        _logger = logger;
    }

    public async Task<RepositoryDto> Handle(
        PublishUnpublishedToAzureCommand request,
        CancellationToken cancellationToken)
    {
        var (accessToken, useBasic) = await GetAdoTokenAsync(request.UserId, cancellationToken);
        if (string.IsNullOrEmpty(accessToken))
            throw new InvalidOperationException("Configure Azure DevOps (PAT or OAuth) in Settings to publish.");

        var repo = await _repositoryRepository.GetByIdIfAccessibleAsync(request.RepositoryId, request.UserId, cancellationToken);
        if (repo == null)
            throw new InvalidOperationException("Repository not found.");
        if (repo.UserId != request.UserId)
            throw new InvalidOperationException("Only the owner can publish.");
        if (repo.Provider != Unpublished)
            throw new InvalidOperationException("This repository is already published to a remote.");

        var org = (request.Organization ?? string.Empty).Trim();
        var project = (request.Project ?? string.Empty).Trim();
        var rname = (request.RepositoryName ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(org) || string.IsNullOrEmpty(project) || string.IsNullOrEmpty(rname))
            throw new ArgumentException("Organization, project, and repository name are required.");

        var readme = string.IsNullOrWhiteSpace(request.ReadmeOverride)
            ? $"# {repo.Name}\n\nCreated from DevPilot. Use Backlog to sync work items to Azure Boards."
            : request.ReadmeOverride!;

        var created = await _ado.CreateGitRepositoryWithInitialReadmeAsync(
            accessToken,
            org,
            project,
            rname,
            readme,
            "main",
            cancellationToken,
            useBasic);

        var fullName = $"{created.OrganizationName}/{created.ProjectName}/{created.Name}";

        repo.PromoteToPublishedRemote(
            name: created.Name,
            fullName: fullName,
            cloneUrl: created.RemoteUrl,
            provider: "AzureDevOps",
            organizationName: created.OrganizationName,
            isPrivate: true,
            defaultBranch: created.DefaultBranch ?? "main");

        await _repositoryRepository.UpdateAsync(repo, cancellationToken);
        _logger.LogInformation("Published repository {Id} to Azure DevOps {FullName}", repo.Id, fullName);

        return await ToDtoAsync(repo, request.UserId, cancellationToken);
    }

    private async Task<(string? token, bool useBasicAuth)> GetAdoTokenAsync(
        Guid userId,
        CancellationToken cancellationToken)
    {
        var user = await _userRepository.GetByIdAsync(userId, cancellationToken);
        if (!string.IsNullOrEmpty(user?.AzureDevOpsAccessToken))
        {
            var basic = Convert.ToBase64String(
                System.Text.Encoding.ASCII.GetBytes($":{user.AzureDevOpsAccessToken}"));
            return (basic, true);
        }

        var linked = await _linkedProviderRepository.GetByUserAndProviderAsync(
            userId, AzureDevOps, cancellationToken);
        if (!string.IsNullOrEmpty(linked?.AccessToken))
            return (linked.AccessToken, false);

        return (null, false);
    }

    private async Task<RepositoryDto> ToDtoAsync(Repository r, Guid userId, CancellationToken cancellationToken)
    {
        var count = await _repositoryShareRepository.GetSharedWithCountsByRepositoryIdsAsync(
            new List<Guid> { r.Id },
            cancellationToken);
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
            IsOwner = true,
            SharedWithCount = count.GetValueOrDefault(r.Id, 0),
        };
    }
}
