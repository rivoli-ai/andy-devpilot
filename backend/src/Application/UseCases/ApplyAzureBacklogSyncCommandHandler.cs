namespace DevPilot.Application.UseCases;

using DevPilot.Domain.Interfaces;
using MediatR;

public record ApplyAzureBacklogSyncCommand(
    Guid RepositoryId,
    Guid UserId,
    string ProjectName,
    int? AreaNodeId,
    IReadOnlyList<Guid> PullEpicIds,
    IReadOnlyList<Guid> PullFeatureIds,
    IReadOnlyList<Guid> PullStoryIds,
    IReadOnlyList<Guid> PushEpicIds,
    IReadOnlyList<Guid> PushFeatureIds,
    IReadOnlyList<Guid> PushStoryIds,
    IReadOnlyList<Guid> CreateEpicIds,
    IReadOnlyList<Guid> CreateFeatureIds,
    IReadOnlyList<Guid> CreateStoryIds) : IRequest<ApplyAzureBacklogSyncResult>;

public class ApplyAzureBacklogSyncResult
{
    public int CreatedCount { get; set; }
    public int PulledCount { get; set; }
    public int PushedCount { get; set; }
    public int FailedCount { get; set; }
    public List<string> Errors { get; set; } = new();
    public bool Success => FailedCount == 0;
}

/// <summary>
/// Runs create-in-Azure, pull-from-Azure, and push-to-Azure in order for the given buckets.
/// </summary>
public class ApplyAzureBacklogSyncCommandHandler : IRequestHandler<ApplyAzureBacklogSyncCommand, ApplyAzureBacklogSyncResult>
{
    private readonly IMediator _mediator;
    private readonly IUserRepository _userRepository;

    public ApplyAzureBacklogSyncCommandHandler(IMediator mediator, IUserRepository userRepository)
    {
        _mediator = mediator;
        _userRepository = userRepository;
    }

    public async Task<ApplyAzureBacklogSyncResult> Handle(ApplyAzureBacklogSyncCommand command, CancellationToken cancellationToken)
    {
        var outResult = new ApplyAzureBacklogSyncResult();
        var project = command.ProjectName.Trim();

        var user = await _userRepository.GetByIdAsync(command.UserId, cancellationToken);
        var org = user?.AzureDevOpsOrganization?.Trim();
        if (string.IsNullOrEmpty(org))
        {
            outResult.Errors.Add("Configure Azure DevOps organization in Settings.");
            outResult.FailedCount++;
            return outResult;
        }

        var anyCreate = command.CreateEpicIds.Count + command.CreateFeatureIds.Count + command.CreateStoryIds.Count > 0;
        if (anyCreate)
        {
            if (command.AreaNodeId is not int aid || aid <= 0)
            {
                outResult.Errors.Add("An area (classification path) is required to create new work items in Azure.");
                outResult.FailedCount++;
                return outResult;
            }
        }

        if (anyCreate)
        {
            var createResult = await _mediator.Send(
                new PushManualBacklogToAzureDevOpsCommand(
                    command.RepositoryId,
                    command.UserId,
                    org,
                    project,
                    command.AreaNodeId!.Value,
                    command.CreateEpicIds,
                    command.CreateFeatureIds,
                    command.CreateStoryIds),
                cancellationToken);
            outResult.CreatedCount = createResult.CreatedCount;
            outResult.FailedCount += createResult.FailedCount;
            outResult.Errors.AddRange(createResult.Errors);
        }

        var anyPull = command.PullEpicIds.Count + command.PullFeatureIds.Count + command.PullStoryIds.Count > 0;
        if (anyPull)
        {
            var pullResult = await _mediator.Send(
                new PullBacklogFromAzureDevOpsCommand(
                    command.RepositoryId,
                    command.UserId,
                    org,
                    project,
                    command.PullEpicIds,
                    command.PullFeatureIds,
                    command.PullStoryIds),
                cancellationToken);
            outResult.PulledCount = pullResult.UpdatedCount;
            outResult.FailedCount += pullResult.FailedCount;
            outResult.Errors.AddRange(pullResult.Errors);
        }

        var anyPush = command.PushEpicIds.Count + command.PushFeatureIds.Count + command.PushStoryIds.Count > 0;
        if (anyPush)
        {
            var pushResult = await _mediator.Send(
                new SyncBacklogToAzureDevOpsCommand(
                    command.RepositoryId,
                    command.UserId,
                    command.PushEpicIds,
                    command.PushFeatureIds,
                    command.PushStoryIds,
                    project),
                cancellationToken);
            outResult.PushedCount = pushResult.SyncedCount;
            outResult.FailedCount += pushResult.FailedCount;
            outResult.Errors.AddRange(pushResult.Errors);
        }

        return outResult;
    }
}
