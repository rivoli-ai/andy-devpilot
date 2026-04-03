using DevPilot.Application.Commands;
using DevPilot.Application.DTOs;
using DevPilot.Application.Services;
using DevPilot.Application.UseCases;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace DevPilot.UnitTests.Application;

public class AnalyzeRepositoryCommandHandlerTests
{
    [Fact]
    public async System.Threading.Tasks.Task Handle_RepositoryNotFound_Throws()
    {
        var mockRepo = new Mock<IRepositoryRepository>();
        mockRepo.Setup(x => x.GetByIdAsync(It.IsAny<Guid>(), default)).ReturnsAsync((Repository?)null);
        var mockAi = new Mock<IAnalysisService>();
        var mockCode = new Mock<ICodeAnalysisService>();
        var h = new AnalyzeRepositoryCommandHandler(mockRepo.Object, mockAi.Object, mockCode.Object, NullLogger<AnalyzeRepositoryCommandHandler>.Instance);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            h.Handle(new AnalyzeRepositoryCommand(Guid.NewGuid()), default));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_UsesAnalysisService_And_SavesCodeAnalysis()
    {
        var repo = new Repository("n", "org/n", "https://g", "GitHub", "o", Guid.NewGuid(), "d");
        var mockRepo = new Mock<IRepositoryRepository>();
        mockRepo.Setup(x => x.GetByIdAsync(repo.Id, default)).ReturnsAsync(repo);

        var analysisResult = new RepositoryAnalysisResult {
            Reasoning = "because",
            Epics = new List<EpicAnalysis>(),
            Metadata = new Metadata { AnalysisTimestamp = "t", Model = "m", Reasoning = "r" }
        };
        var mockAi = new Mock<IAnalysisService>();
        mockAi.Setup(x => x.AnalyzeRepositoryAsync(repo.UserId, repo.Id, It.IsAny<string>(), repo.FullName, default))
            .ReturnsAsync(analysisResult);

        var mockCode = new Mock<ICodeAnalysisService>();
        mockCode.Setup(x => x.SaveAnalysisResultAsync(
                repo.Id, It.IsAny<string?>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(),
                It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), default))
            .ReturnsAsync(new CodeAnalysisResult { Id = Guid.NewGuid(), RepositoryId = repo.Id, Branch = "main", Summary = "s" });

        var h = new AnalyzeRepositoryCommandHandler(mockRepo.Object, mockAi.Object, mockCode.Object, NullLogger<AnalyzeRepositoryCommandHandler>.Instance);
        var result = await h.Handle(new AnalyzeRepositoryCommand(repo.Id, "content"), default);
        result.Should().BeSameAs(analysisResult);
        mockCode.Verify(x => x.SaveAnalysisResultAsync(
            repo.Id, It.IsAny<string?>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), default), Times.Once);
    }
}

public class SyncRepositoriesFromGitHubCommandHandlerTests
{
    private static GitHubRepositoryDto Gh(string full = "o/n") => new() {
        Name = "n",
        FullName = full,
        CloneUrl = "https://c",
        Description = "d",
        IsPrivate = false,
        DefaultBranch = "main",
        OrganizationName = "o"
    };

    [Fact]
    public async System.Threading.Tasks.Task Handle_Inserts_WhenNotExists()
    {
        var userId = Guid.NewGuid();
        var mockGit = new Mock<IGitHubService>();
        mockGit.Setup(x => x.GetRepositoriesAsync("tok", default)).ReturnsAsync(new[] { Gh() });
        var mockDb = new Mock<IRepositoryRepository>();
        mockDb.Setup(x => x.GetByUserIdAsync(userId, default)).ReturnsAsync(Array.Empty<Repository>());
        mockDb.Setup(x => x.AddAsync(It.IsAny<Repository>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((Repository r, CancellationToken _) => r);

        var h = new SyncRepositoriesFromGitHubCommandHandler(mockGit.Object, mockDb.Object, NullLogger<SyncRepositoriesFromGitHubCommandHandler>.Instance);
        var list = (await h.Handle(new SyncRepositoriesFromGitHubCommand(userId, "tok"), default)).ToList();
        list.Should().HaveCount(1);
        mockDb.Verify(x => x.AddAsync(It.IsAny<Repository>(), default), Times.Once);
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_Updates_WhenExists()
    {
        var userId = Guid.NewGuid();
        var existing = new Repository("n", "o/n", "https://c", "GitHub", "o", userId, "old", false, "main");
        var mockGit = new Mock<IGitHubService>();
        mockGit.Setup(x => x.GetRepositoriesAsync("tok", default)).ReturnsAsync(new[] { Gh() });
        var mockDb = new Mock<IRepositoryRepository>();
        mockDb.Setup(x => x.GetByUserIdAsync(userId, default)).ReturnsAsync(new[] { existing });

        var h = new SyncRepositoriesFromGitHubCommandHandler(mockGit.Object, mockDb.Object, NullLogger<SyncRepositoriesFromGitHubCommandHandler>.Instance);
        _ = await h.Handle(new SyncRepositoriesFromGitHubCommand(userId, "tok"), default);
        mockDb.Verify(x => x.UpdateAsync(existing, default), Times.Once);
    }
}
