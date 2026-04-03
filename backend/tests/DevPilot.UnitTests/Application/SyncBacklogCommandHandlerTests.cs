using DevPilot.Application.Services;
using DevPilot.Application.UseCases;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace DevPilot.UnitTests.Application;

public class SyncBacklogToGitHubCommandHandlerTests
{
    private static SyncBacklogToGitHubCommandHandler CreateHandler(
        out Mock<IEpicRepository> epicMock,
        out Mock<IRepositoryRepository> repoMock,
        out Mock<IUserRepository> userMock,
        out Mock<ILinkedProviderRepository> linkMock,
        out Mock<IGitHubService> ghMock)
    {
        epicMock = new Mock<IEpicRepository>();
        repoMock = new Mock<IRepositoryRepository>();
        userMock = new Mock<IUserRepository>();
        linkMock = new Mock<ILinkedProviderRepository>();
        ghMock = new Mock<IGitHubService>();
        return new SyncBacklogToGitHubCommandHandler(
            epicMock.Object,
            repoMock.Object,
            userMock.Object,
            linkMock.Object,
            ghMock.Object,
            NullLogger<SyncBacklogToGitHubCommandHandler>.Instance);
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_RepositoryMissing_ReturnsError()
    {
        var h = CreateHandler(out _, out var repoMock, out _, out _, out _);
        repoMock.Setup(x => x.GetByIdAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((Repository?)null);
        var r = await h.Handle(new SyncBacklogToGitHubCommand(Guid.NewGuid(), Guid.NewGuid(), [], [], []), default);
        r.Success.Should().BeFalse();
        r.Errors.Should().Contain(e => e.Contains("not found", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_NotGitHubProvider_ReturnsError()
    {
        var h = CreateHandler(out _, out var repoMock, out _, out _, out _);
        var repo = new Repository("n", "o/n", "c", "AzureDevOps", "o", Guid.NewGuid());
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        var r = await h.Handle(new SyncBacklogToGitHubCommand(repo.Id, Guid.NewGuid(), [], [], []), default);
        r.Success.Should().BeFalse();
        r.Errors.Should().Contain(e => e.Contains("GitHub", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_InvalidFullName_ReturnsError()
    {
        var h = CreateHandler(out _, out var repoMock, out _, out _, out _);
        var repo = new Repository("n", "badname", "c", "GitHub", "o", Guid.NewGuid());
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        var r = await h.Handle(new SyncBacklogToGitHubCommand(repo.Id, Guid.NewGuid(), [], [], []), default);
        r.Success.Should().BeFalse();
        r.Errors.Should().Contain(e => e.Contains("full name", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_NoToken_ReturnsError()
    {
        var h = CreateHandler(out _, out var repoMock, out var userMock, out var linkMock, out _);
        var uid = Guid.NewGuid();
        var repo = new Repository("n", "o/n", "c", "GitHub", "o", uid);
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        linkMock.Setup(x => x.GetByUserAndProviderAsync(uid, ProviderTypes.GitHub, It.IsAny<CancellationToken>()))
            .ReturnsAsync((LinkedProvider?)null);
        userMock.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(new User("a@b.c"));

        var r = await h.Handle(new SyncBacklogToGitHubCommand(repo.Id, uid, [], [], []), default);
        r.Success.Should().BeFalse();
        r.Errors.Should().Contain(e => e.Contains("token", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_LinkedProviderToken_Used()
    {
        var h = CreateHandler(out var epicMock, out var repoMock, out _, out var linkMock, out var ghMock);
        var uid = Guid.NewGuid();
        var repo = new Repository("n", "org/repo", "c", "GitHub", "o", uid);
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        linkMock.Setup(x => x.GetByUserAndProviderAsync(uid, ProviderTypes.GitHub, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new LinkedProvider(uid, ProviderTypes.GitHub, "gh", "tokGH"));

        var epic = new Epic("E", repo.Id);
        var feat = new Feature("F", epic.Id, source: "GitHub", githubIssueNumber: 42);
        epic.Features.Add(feat);
        epicMock.Setup(x => x.GetByRepositoryIdAsync(repo.Id, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { epic });

        ghMock.Setup(x => x.UpdateIssueAsync("tokGH", "org", "repo", 42, It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .Returns(System.Threading.Tasks.Task.CompletedTask);

        var r = await h.Handle(new SyncBacklogToGitHubCommand(repo.Id, uid, [], [], []), default);
        r.Success.Should().BeTrue();
        r.SyncedCount.Should().Be(1);
        ghMock.Verify(x => x.UpdateIssueAsync("tokGH", "org", "repo", 42, feat.Title, It.IsAny<string?>(), "open", It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_DoneStatus_ClosesIssue()
    {
        var h = CreateHandler(out var epicMock, out var repoMock, out var userMock, out _, out var ghMock);
        var uid = Guid.NewGuid();
        var repo = new Repository("n", "org/repo", "c", "GitHub", "o", uid);
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        var u = new User("a@b.c");
        u.UpdateGitHubToken("tok");
        userMock.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(u);

        var epic = new Epic("E", repo.Id);
        var feat = new Feature("F", epic.Id, source: "GitHub", githubIssueNumber: 7);
        feat.ChangeStatus("Done");
        epic.Features.Add(feat);
        epicMock.Setup(x => x.GetByRepositoryIdAsync(repo.Id, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { epic });

        ghMock.Setup(x => x.UpdateIssueAsync("tok", "org", "repo", 7, It.IsAny<string?>(), It.IsAny<string?>(), "closed", It.IsAny<CancellationToken>()))
            .Returns(System.Threading.Tasks.Task.CompletedTask);

        var r = await h.Handle(new SyncBacklogToGitHubCommand(repo.Id, uid, [], [], []), default);
        r.Success.Should().BeTrue();
        ghMock.Verify(x => x.UpdateIssueAsync("tok", "org", "repo", 7, It.IsAny<string?>(), It.IsAny<string?>(), "closed", It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_NoGitHubLinkedItems_ReturnsSuccessWithMessage()
    {
        var h = CreateHandler(out var epicMock, out var repoMock, out var userMock, out _, out _);
        var uid = Guid.NewGuid();
        var repo = new Repository("n", "o/r", "c", "GitHub", "o", uid);
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        var u = new User("a@b.c");
        u.UpdateGitHubToken("tok");
        userMock.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(u);
        epicMock.Setup(x => x.GetByRepositoryIdAsync(repo.Id, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { new Epic("E", repo.Id) });

        var r = await h.Handle(new SyncBacklogToGitHubCommand(repo.Id, uid, [], [], []), default);
        r.Success.Should().BeTrue();
        r.SyncedCount.Should().Be(0);
        r.Errors.Should().Contain(e => e.Contains("No items", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_FilterByStoryId_SkipsOthers()
    {
        var h = CreateHandler(out var epicMock, out var repoMock, out var userMock, out _, out var ghMock);
        var uid = Guid.NewGuid();
        var repo = new Repository("n", "o/r", "c", "GitHub", "o", uid);
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        var u = new User("a@b.c");
        u.UpdateGitHubToken("t");
        userMock.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(u);

        var epic = new Epic("E", repo.Id);
        var f1 = new Feature("F1", epic.Id);
        var keep = new UserStory("S1", f1.Id, source: "GitHub", githubIssueNumber: 1);
        var skip = new UserStory("S2", f1.Id, source: "GitHub", githubIssueNumber: 2);
        f1.UserStories.Add(keep);
        f1.UserStories.Add(skip);
        epic.Features.Add(f1);
        epicMock.Setup(x => x.GetByRepositoryIdAsync(repo.Id, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { epic });

        ghMock.Setup(x => x.UpdateIssueAsync("t", "o", "r", It.IsAny<int>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .Returns(System.Threading.Tasks.Task.CompletedTask);

        var r = await h.Handle(new SyncBacklogToGitHubCommand(repo.Id, uid, [], [], [keep.Id]), default);
        r.SyncedCount.Should().Be(1);
        ghMock.Verify(x => x.UpdateIssueAsync("t", "o", "r", 1, It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Once);
        ghMock.Verify(x => x.UpdateIssueAsync("t", "o", "r", 2, It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_UpdateIssueFails_CountsFailed()
    {
        var h = CreateHandler(out var epicMock, out var repoMock, out var userMock, out _, out var ghMock);
        var uid = Guid.NewGuid();
        var repo = new Repository("n", "o/r", "c", "GitHub", "o", uid);
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        var u = new User("a@b.c");
        u.UpdateGitHubToken("t");
        userMock.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(u);

        var epic = new Epic("E", repo.Id);
        var feat = new Feature("F", epic.Id, source: "GitHub", githubIssueNumber: 9);
        epic.Features.Add(feat);
        epicMock.Setup(x => x.GetByRepositoryIdAsync(repo.Id, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { epic });

        ghMock.Setup(x => x.UpdateIssueAsync("t", "o", "r", 9, It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("api"));

        var r = await h.Handle(new SyncBacklogToGitHubCommand(repo.Id, uid, [], [], []), default);
        r.Success.Should().BeFalse();
        r.FailedCount.Should().Be(1);
        r.SyncedCount.Should().Be(0);
    }
}

public class SyncBacklogToAzureDevOpsCommandHandlerTests
{
    private static SyncBacklogToAzureDevOpsCommandHandler CreateHandler(
        out Mock<IEpicRepository> epicMock,
        out Mock<IRepositoryRepository> repoMock,
        out Mock<IUserRepository> userMock,
        out Mock<IAzureDevOpsService> adoMock)
    {
        epicMock = new Mock<IEpicRepository>();
        repoMock = new Mock<IRepositoryRepository>();
        userMock = new Mock<IUserRepository>();
        adoMock = new Mock<IAzureDevOpsService>();
        return new SyncBacklogToAzureDevOpsCommandHandler(
            epicMock.Object,
            repoMock.Object,
            userMock.Object,
            adoMock.Object,
            NullLogger<SyncBacklogToAzureDevOpsCommandHandler>.Instance);
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_RepositoryMissing_ReturnsError()
    {
        var h = CreateHandler(out _, out var repoMock, out _, out _);
        repoMock.Setup(x => x.GetByIdAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>())).ReturnsAsync((Repository?)null);
        var r = await h.Handle(new SyncBacklogToAzureDevOpsCommand(Guid.NewGuid(), Guid.NewGuid(), [], [], []), default);
        r.Success.Should().BeFalse();
        r.Errors.Should().Contain(e => e.Contains("not found", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_NotAzureDevOps_ReturnsError()
    {
        var h = CreateHandler(out _, out var repoMock, out _, out _);
        var repo = new Repository("n", "o/r", "c", "GitHub", "o", Guid.NewGuid());
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        var r = await h.Handle(new SyncBacklogToAzureDevOpsCommand(repo.Id, Guid.NewGuid(), [], [], []), default);
        r.Success.Should().BeFalse();
        r.Errors.Should().Contain(e => e.Contains("Azure DevOps", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_InvalidFullName_ReturnsError()
    {
        var h = CreateHandler(out _, out var repoMock, out _, out _);
        var repo = new Repository("n", "onlyone", "c", "AzureDevOps", "o", Guid.NewGuid());
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        var r = await h.Handle(new SyncBacklogToAzureDevOpsCommand(repo.Id, Guid.NewGuid(), [], [], []), default);
        r.Success.Should().BeFalse();
        r.Errors.Should().Contain(e => e.Contains("full name", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_UserMissing_ReturnsError()
    {
        var h = CreateHandler(out _, out var repoMock, out var userMock, out _);
        var repo = new Repository("n", "org/proj", "c", "AzureDevOps", "o", Guid.NewGuid());
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        userMock.Setup(x => x.GetByIdAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>())).ReturnsAsync((User?)null);
        var r = await h.Handle(new SyncBacklogToAzureDevOpsCommand(repo.Id, Guid.NewGuid(), [], [], []), default);
        r.Success.Should().BeFalse();
        r.Errors.Should().Contain(e => e.Contains("User not found", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_NoAdoToken_ReturnsError()
    {
        var h = CreateHandler(out _, out var repoMock, out var userMock, out _);
        var uid = Guid.NewGuid();
        var repo = new Repository("n", "org/proj", "c", "AzureDevOps", "o", uid);
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        userMock.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(new User("a@b.c"));
        var r = await h.Handle(new SyncBacklogToAzureDevOpsCommand(repo.Id, uid, [], [], []), default);
        r.Success.Should().BeFalse();
        r.Errors.Should().Contain(e => e.Contains("Azure DevOps access token", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_NoLinkedWorkItems_ReturnsSuccessWithMessage()
    {
        var h = CreateHandler(out var epicMock, out var repoMock, out var userMock, out _);
        var uid = Guid.NewGuid();
        var repo = new Repository("n", "org/proj", "c", "AzureDevOps", "o", uid);
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        var u = new User("a@b.c");
        u.UpdateAzureDevOpsToken("pat");
        userMock.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(u);
        epicMock.Setup(x => x.GetByRepositoryIdAsync(repo.Id, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { new Epic("E", repo.Id) });

        var r = await h.Handle(new SyncBacklogToAzureDevOpsCommand(repo.Id, uid, [], [], []), default);
        r.Success.Should().BeTrue();
        r.SyncedCount.Should().Be(0);
        r.Errors.Should().Contain(e => e.Contains("No items", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_Syncs_UserStory_WithPatches()
    {
        var h = CreateHandler(out var epicMock, out var repoMock, out var userMock, out var adoMock);
        var uid = Guid.NewGuid();
        var repo = new Repository("n", "org/proj", "c", "AzureDevOps", "o", uid);
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        var u = new User("a@b.c");
        u.UpdateAzureDevOpsToken("secret");
        userMock.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(u);

        var epic = new Epic("E", repo.Id);
        var feat = new Feature("F", epic.Id);
        var story = new UserStory(
            "S",
            feat.Id,
            description: "plain desc",
            acceptanceCriteria: "Given x - Given y",
            storyPoints: 5,
            source: "AzureDevOps",
            azureDevOpsWorkItemId: 1001);
        story.ChangeStatus("Done");
        feat.UserStories.Add(story);
        epic.Features.Add(feat);
        epicMock.Setup(x => x.GetByRepositoryIdAsync(repo.Id, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { epic });

        var expectedB64 = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes(":secret"));
        adoMock.Setup(x => x.GetWorkItemTypesByIdsAsync(
                expectedB64, "org", "proj", It.IsAny<IReadOnlyList<int>>(), It.IsAny<CancellationToken>(), true))
            .ReturnsAsync(new Dictionary<int, string> { [1001] = "User Story" });
        adoMock.Setup(x => x.GetWorkItemTypeStatesAsync(
                expectedB64, "org", "proj", "User Story", It.IsAny<CancellationToken>(), true))
            .ReturnsAsync(new List<AzureDevOpsWorkItemStateDto> {
                new() { Name = "Closed", Category = "Completed" }
            });
        adoMock.Setup(x => x.UpdateWorkItemAsync(
                expectedB64, "org", "proj", 1001, It.IsAny<IReadOnlyList<AzureDevOpsWorkItemPatchOperation>>(),
                It.IsAny<CancellationToken>(), true))
            .Returns(System.Threading.Tasks.Task.CompletedTask);

        var r = await h.Handle(new SyncBacklogToAzureDevOpsCommand(repo.Id, uid, [], [], []), default);
        r.Success.Should().BeTrue();
        r.SyncedCount.Should().Be(1);
        adoMock.Verify(x => x.UpdateWorkItemAsync(
            expectedB64, "org", "proj", 1001, It.IsAny<IReadOnlyList<AzureDevOpsWorkItemPatchOperation>>(),
            It.IsAny<CancellationToken>(), true), Times.Once);
    }

    [Fact]
    public async System.Threading.Tasks.Task Handle_UpdateWorkItemFails_CountsFailed()
    {
        var h = CreateHandler(out var epicMock, out var repoMock, out var userMock, out var adoMock);
        var uid = Guid.NewGuid();
        var repo = new Repository("n", "org/proj", "c", "AzureDevOps", "o", uid);
        repoMock.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        var u = new User("a@b.c");
        u.UpdateAzureDevOpsToken("secret");
        userMock.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(u);

        var epic = new Epic("E", repo.Id, source: "AzureDevOps", azureDevOpsWorkItemId: 55);
        epicMock.Setup(x => x.GetByRepositoryIdAsync(repo.Id, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { epic });

        var b64 = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes(":secret"));
        adoMock.Setup(x => x.GetWorkItemTypesByIdsAsync(
                b64, "org", "proj", It.IsAny<IReadOnlyList<int>>(), It.IsAny<CancellationToken>(), true))
            .ReturnsAsync(new Dictionary<int, string> { [55] = "Epic" });
        adoMock.Setup(x => x.GetWorkItemTypeStatesAsync(
                b64, "org", "proj", "Epic", It.IsAny<CancellationToken>(), true))
            .ReturnsAsync(new List<AzureDevOpsWorkItemStateDto>());
        adoMock.Setup(x => x.UpdateWorkItemAsync(
                b64, "org", "proj", 55, It.IsAny<IReadOnlyList<AzureDevOpsWorkItemPatchOperation>>(),
                It.IsAny<CancellationToken>(), true))
            .ThrowsAsync(new InvalidOperationException("ado"));

        var r = await h.Handle(new SyncBacklogToAzureDevOpsCommand(repo.Id, uid, [], [], []), default);
        r.Success.Should().BeFalse();
        r.FailedCount.Should().Be(1);
    }
}
