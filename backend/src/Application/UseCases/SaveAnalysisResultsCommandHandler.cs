namespace DevPilot.Application.UseCases;

using DevPilot.Application.Commands;
using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using MediatR;
using Microsoft.Extensions.Logging;

/// <summary>
/// Handler for SaveAnalysisResultsCommand
/// Persists Epics, Features, User Stories, and Tasks from analysis results to the database
/// </summary>
public class SaveAnalysisResultsCommandHandler : IRequestHandler<SaveAnalysisResultsCommand, int>
{
    private readonly IEpicRepository _epicRepository;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly ILogger<SaveAnalysisResultsCommandHandler> _logger;

    public SaveAnalysisResultsCommandHandler(
        IEpicRepository epicRepository,
        IRepositoryRepository repositoryRepository,
        ILogger<SaveAnalysisResultsCommandHandler> logger)
    {
        _epicRepository = epicRepository ?? throw new ArgumentNullException(nameof(epicRepository));
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<int> Handle(
        SaveAnalysisResultsCommand request,
        CancellationToken cancellationToken)
    {
        // Verify repository exists
        var repository = await _repositoryRepository.GetByIdAsync(request.RepositoryId, cancellationToken);
        if (repository == null)
        {
            throw new InvalidOperationException($"Repository with ID {request.RepositoryId} not found");
        }

        int totalItemsSaved = 0;

        // Persist each Epic with its Features, User Stories, and Tasks
        foreach (var epicAnalysis in request.AnalysisResult.Epics)
        {
            // Create Epic entity
            var epic = new Epic(
                title: epicAnalysis.Title,
                repositoryId: request.RepositoryId,
                description: epicAnalysis.Description);

            // Add Features to the Epic through navigation property
            foreach (var featureAnalysis in epicAnalysis.Features)
            {
                var feature = new Feature(
                    title: featureAnalysis.Title,
                    epicId: epic.Id,
                    description: featureAnalysis.Description);

                // Add User Stories to the Feature through navigation property
                foreach (var userStoryAnalysis in featureAnalysis.UserStories)
                {
                    var userStory = new UserStory(
                        title: userStoryAnalysis.Title,
                        featureId: feature.Id,
                        description: userStoryAnalysis.Description,
                        acceptanceCriteria: userStoryAnalysis.AcceptanceCriteria);

                    // Add Tasks to the User Story through navigation property
                    foreach (var taskAnalysis in userStoryAnalysis.Tasks)
                    {
                        var task = new Domain.Entities.Task(
                            title: taskAnalysis.Title,
                            userStoryId: userStory.Id,
                            complexity: taskAnalysis.Complexity,
                            description: taskAnalysis.Description);

                        // Add task to user story's tasks list (navigation property supports Add)
                        userStory.Tasks.Add(task);
                    }

                    // Add user story to feature's user stories list
                    feature.UserStories.Add(userStory);
                }

                // Add feature to epic's features list
                epic.Features.Add(feature);
            }

            // Save Epic (Features, User Stories, and Tasks are saved through navigation properties)
            await _epicRepository.AddAsync(epic, cancellationToken);
            totalItemsSaved += 1 + epicAnalysis.Features.Count + 
                epicAnalysis.Features.Sum(f => f.UserStories.Count) +
                epicAnalysis.Features.Sum(f => f.UserStories.Sum(us => us.Tasks.Count));
        }

        _logger.LogInformation("Saved analysis results for repository {RepositoryId}. Total items: {TotalItems}", 
            request.RepositoryId, totalItemsSaved);

        return totalItemsSaved;
    }
}
