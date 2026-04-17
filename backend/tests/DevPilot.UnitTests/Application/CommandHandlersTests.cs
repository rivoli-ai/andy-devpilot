using System.Linq;
using DevPilot.Application.Commands;
using DevPilot.Application.Services;
using DevPilot.Application.UseCases;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace DevPilot.UnitTests.Application;

public class UpdateStoryStatusCommandHandlerTests
{
    [Fact]
    public async System.Threading.Tasks.Task Handle_InvalidStatus_Throws()
    {
        var mock = new Mock<IUserStoryRepository>();
        var h = new UpdateStoryStatusCommandHandler(mock.Object, NullLogger<UpdateStoryStatusCommandHandler>.Instance);
        await Assert.ThrowsAsync<ArgumentException>(() =>
            h.Handle(new UpdateStoryStatusCommand(Guid.NewGuid(), "nope"), default));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_NotFound_ReturnsFalse()
    {
        var mock = new Mock<IUserStoryRepository>();
        mock.Setup(x => x.GetByIdAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>())).ReturnsAsync((UserStory?)null);
        var h = new UpdateStoryStatusCommandHandler(mock.Object, NullLogger<UpdateStoryStatusCommandHandler>.Instance);
        var ok = await h.Handle(new UpdateStoryStatusCommand(Guid.NewGuid(), "Done"), default);
        ok.Should().BeFalse();
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_Updates()
    {
        var story = new UserStory("S", Guid.NewGuid());
        var mock = new Mock<IUserStoryRepository>();
        mock.Setup(x => x.GetByIdAsync(story.Id, It.IsAny<CancellationToken>())).ReturnsAsync(story);
        var h = new UpdateStoryStatusCommandHandler(mock.Object, NullLogger<UpdateStoryStatusCommandHandler>.Instance);
        var ok = await h.Handle(new UpdateStoryStatusCommand(story.Id, "PendingReview", "https://pr"), default);
        ok.Should().BeTrue();
        mock.Verify(x => x.UpdateAsync(story, It.IsAny<CancellationToken>()), Times.Once);
    }
}

public class DeleteBacklogHandlersTests
{
    [Fact]
    public async System.Threading.Tasks.Task DeleteEpic_NotFound()
    {
        var mock = new Mock<IEpicRepository>();
        mock.Setup(x => x.GetByIdAsync(It.IsAny<Guid>(), default)).ReturnsAsync((Epic?)null);
        var h = new DeleteEpicCommandHandler(mock.Object, NullLogger<DeleteEpicCommandHandler>.Instance);
        (await h.Handle(new DeleteEpicCommand(Guid.NewGuid()), default)).Should().BeFalse();
    }

    [Fact]
    public async System.Threading.Tasks.Task DeleteEpic_Deletes()
    {
        var e = new Epic("E", Guid.NewGuid());
        var mock = new Mock<IEpicRepository>();
        mock.Setup(x => x.GetByIdAsync(e.Id, default)).ReturnsAsync(e);
        var h = new DeleteEpicCommandHandler(mock.Object, NullLogger<DeleteEpicCommandHandler>.Instance);
        (await h.Handle(new DeleteEpicCommand(e.Id), default)).Should().BeTrue();
    }

    [Fact]
    public async System.Threading.Tasks.Task DeleteFeature_And_Story()
    {
        var f = new Feature("F", Guid.NewGuid());
        var mockF = new Mock<IFeatureRepository>();
        mockF.Setup(x => x.GetByIdAsync(f.Id, default)).ReturnsAsync(f);
        var hf = new DeleteFeatureCommandHandler(mockF.Object, NullLogger<DeleteFeatureCommandHandler>.Instance);
        (await hf.Handle(new DeleteFeatureCommand(f.Id), default)).Should().BeTrue();

        var s = new UserStory("S", Guid.NewGuid());
        var mockS = new Mock<IUserStoryRepository>();
        mockS.Setup(x => x.GetByIdAsync(s.Id, default)).ReturnsAsync(s);
        var hs = new DeleteUserStoryCommandHandler(mockS.Object, NullLogger<DeleteUserStoryCommandHandler>.Instance);
        (await hs.Handle(new DeleteUserStoryCommand(s.Id), default)).Should().BeTrue();
    }
}

public class AddBacklogItemHandlersTests
{
    [Fact]
    public async System.Threading.Tasks.Task AddEpic_Throws_WhenRepoMissing()
    {
        var mockE = new Mock<IEpicRepository>();
        var mockR = new Mock<IRepositoryRepository>();
        mockR.Setup(x => x.GetByIdAsync(It.IsAny<Guid>(), default)).ReturnsAsync((Repository?)null);
        var h = new AddEpicCommandHandler(mockE.Object, mockR.Object, NullLogger<AddEpicCommandHandler>.Instance);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            h.Handle(new AddEpicCommand(Guid.NewGuid(), "T"), default));
    }

    [Fact]
    public async System.Threading.Tasks.Task AddEpic_Adds()
    {
        var repo = new Repository("n", "f", "c", "GitHub", "o", Guid.NewGuid());
        var mockR = new Mock<IRepositoryRepository>();
        mockR.Setup(x => x.GetByIdAsync(repo.Id, default)).ReturnsAsync(repo);
        var mockE = new Mock<IEpicRepository>();
        mockE.Setup(x => x.AddAsync(It.IsAny<Epic>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((Epic e, CancellationToken _) => e);
        var h = new AddEpicCommandHandler(mockE.Object, mockR.Object, NullLogger<AddEpicCommandHandler>.Instance);
        var dto = await h.Handle(new AddEpicCommand(repo.Id, "Epic"), default);
        dto.Title.Should().Be("Epic");
    }

    [Fact]
    public async System.Threading.Tasks.Task AddFeature_And_UserStory()
    {
        var epic = new Epic("E", Guid.NewGuid());
        var mockEpic = new Mock<IEpicRepository>();
        mockEpic.Setup(x => x.GetByIdAsync(epic.Id, default)).ReturnsAsync(epic);
        var mockFeat = new Mock<IFeatureRepository>();
        mockFeat.Setup(x => x.AddAsync(It.IsAny<Feature>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((Feature f, CancellationToken _) => f);
        var hf = new AddFeatureCommandHandler(mockFeat.Object, mockEpic.Object, NullLogger<AddFeatureCommandHandler>.Instance);
        (await hf.Handle(new AddFeatureCommand(epic.Id, "F"), default)).Title.Should().Be("F");

        var feat = new Feature("F2", epic.Id);
        var mockF2 = new Mock<IFeatureRepository>();
        mockF2.Setup(x => x.GetByIdAsync(feat.Id, default)).ReturnsAsync(feat);
        var mockUs = new Mock<IUserStoryRepository>();
        mockUs.Setup(x => x.AddAsync(It.IsAny<UserStory>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((UserStory u, CancellationToken _) => u);
        var mockRules = new Mock<IRepositoryAgentRuleRepository>();
        var hu = new AddUserStoryCommandHandler(
            mockUs.Object,
            mockF2.Object,
            mockRules.Object,
            NullLogger<AddUserStoryCommandHandler>.Instance);
        (await hu.Handle(new AddUserStoryCommand(feat.Id, "US"), default)).Title.Should().Be("US");
    }
}

public class CreateAndSaveBacklogTests
{
    [Fact]
    public async System.Threading.Tasks.Task CreateBacklog_EmptyRequest_ReturnsEmpty()
    {
        var repo = new Repository("n", "f", "c", "GitHub", "o", Guid.NewGuid());
        var mockR = new Mock<IRepositoryRepository>();
        mockR.Setup(x => x.GetByIdAsync(repo.Id, default)).ReturnsAsync(repo);
        var mockE = new Mock<IEpicRepository>();
        var h = new CreateBacklogCommandHandler(mockE.Object, mockR.Object, NullLogger<CreateBacklogCommandHandler>.Instance);
        var r = await h.Handle(new CreateBacklogCommand(repo.Id, new CreateBacklogRequest()), default);
        r.Should().BeEmpty();
    }

    [Fact]
    public async System.Threading.Tasks.Task CreateBacklog_CreatesTree()
 {
        var repo = new Repository("n", "f", "c", "GitHub", "o", Guid.NewGuid());
        var mockR = new Mock<IRepositoryRepository>();
        mockR.Setup(x => x.GetByIdAsync(repo.Id, default)).ReturnsAsync(repo);
        var mockE = new Mock<IEpicRepository>();
        mockE.Setup(x => x.AddAsync(It.IsAny<Epic>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((Epic e, CancellationToken _) => e);
        var h = new CreateBacklogCommandHandler(mockE.Object, mockR.Object, NullLogger<CreateBacklogCommandHandler>.Instance);
        var req = new CreateBacklogRequest
        {
            Epics = {
                new CreateEpicRequest {
                    Title = "E",
                    Description = "d",
                    Features = {
                        new CreateFeatureRequest {
                            Title = "F",
                            Description = "d",
                            UserStories = {
                                new CreateUserStoryRequest {
                                    Title = "S",
                                    Description = "d",
                                    AcceptanceCriteria = new List<string> { "a", "b" }
                                }
                            }
                        }
                    }
                }
            }
        };
        var result = await h.Handle(new CreateBacklogCommand(repo.Id, req), default);
        result.Should().HaveCount(1);
        result.First().Features.Should().HaveCount(1);
    }

    [Fact]
    public async System.Threading.Tasks.Task SaveAnalysis_Throws_WhenRepoMissing()
    {
        var mockR = new Mock<IRepositoryRepository>();
        mockR.Setup(x => x.GetByIdAsync(It.IsAny<Guid>(), default)).ReturnsAsync((Repository?)null);
        var mockE = new Mock<IEpicRepository>();
        var h = new SaveAnalysisResultsCommandHandler(mockE.Object, mockR.Object, NullLogger<SaveAnalysisResultsCommandHandler>.Instance);
        var analysis = new RepositoryAnalysisResult {
            Reasoning = "r",
            Epics = new List<EpicAnalysis>(),
            Metadata = new Metadata { AnalysisTimestamp = "t", Model = "m", Reasoning = "r" }
        };
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            h.Handle(new SaveAnalysisResultsCommand(Guid.NewGuid(), analysis), default));
    }

    [Fact]
    public async System.Threading.Tasks.Task SaveAnalysis_Persists()
    {
        var repo = new Repository("n", "f", "c", "GitHub", "o", Guid.NewGuid());
        var mockR = new Mock<IRepositoryRepository>();
        mockR.Setup(x => x.GetByIdAsync(repo.Id, default)).ReturnsAsync(repo);
        var mockE = new Mock<IEpicRepository>();
        mockE.Setup(x => x.AddAsync(It.IsAny<Epic>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((Epic e, CancellationToken _) => e);
        var h = new SaveAnalysisResultsCommandHandler(mockE.Object, mockR.Object, NullLogger<SaveAnalysisResultsCommandHandler>.Instance);
        var analysis = new RepositoryAnalysisResult {
            Reasoning = "r",
            Epics = new List<EpicAnalysis> {
                new EpicAnalysis {
                    Title = "E",
                    Description = "d",
                    Features = new List<FeatureAnalysis> {
                        new FeatureAnalysis {
                            Title = "F",
                            Description = "d",
                            UserStories = new List<UserStoryAnalysis> {
                                new UserStoryAnalysis {
                                    Title = "S",
                                    Description = "d",
                                    AcceptanceCriteria = "ac",
                                    Tasks = new List<TaskAnalysis> {
                                        new TaskAnalysis { Title = "T", Description = "d", Complexity = "Simple" }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            Metadata = new Metadata { AnalysisTimestamp = "t", Model = "m", Reasoning = "r" }
        };
        var n = await h.Handle(new SaveAnalysisResultsCommand(repo.Id, analysis), default);
        n.Should().BeGreaterThan(0);
    }
}
