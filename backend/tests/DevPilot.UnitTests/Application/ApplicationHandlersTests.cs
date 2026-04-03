using DevPilot.Application.Commands;
using DevPilot.Application.DTOs;
using DevPilot.Application.Queries;
using DevPilot.Application.Services;
using DevPilot.Application.UseCases;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using FluentAssertions;
using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace DevPilot.UnitTests.Application;

public class QueryAndResultTests
{
    [Fact]
    public void GetRepositoriesPaginatedQuery_Clamps_Page_And_PageSize()
    {
        var q = new GetRepositoriesPaginatedQuery(Guid.NewGuid(), page: 0, pageSize: 500);
        q.Page.Should().Be(1);
        q.PageSize.Should().Be(100);
    }

    [Fact]
    public void PagedRepositoriesResult_ComputedProperties()
    {
        var r = new PagedRepositoriesResult { TotalCount = 41, Page = 2, PageSize = 20 };
        r.TotalPages.Should().Be(3);
        r.HasMore.Should().BeTrue();
    }
}

public class GetBacklogByRepositoryIdQueryHandlerTests
{
    [Fact]
    public async System.Threading.Tasks.Task Handle_Maps_Hierarchy()
    {
        var repoId = Guid.NewGuid();
        var epic = new Epic("E", repoId);
        var feat = new Feature("F", epic.Id);
        var story = new UserStory("S", feat.Id);
        var workTask = new DevPilot.Domain.Entities.Task("T", story.Id);
        story.Tasks.Add(workTask);
        feat.UserStories.Add(story);
        epic.Features.Add(feat);

        var mockEpic = new Mock<IEpicRepository>();
        mockEpic.Setup(x => x.GetByRepositoryIdAsync(repoId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { epic });

        var h = new GetBacklogByRepositoryIdQueryHandler(mockEpic.Object);
        var dto = (await h.Handle(new GetBacklogByRepositoryIdQuery(repoId), default)).Single();
        dto.Title.Should().Be("E");
        dto.Features.Should().HaveCount(1);
        dto.Features[0].UserStories.Should().HaveCount(1);
        dto.Features[0].UserStories[0].Tasks.Should().HaveCount(1);
        dto.Features[0].UserStories[0].Tasks[0].Title.Should().Be("T");
    }
}

public class GetRepositoriesByUserIdQueryHandlerTests
{
    [Fact]
    public async System.Threading.Tasks.Task Handle_FilterMine_And_SharedMetadata()
    {
        var uid = Guid.NewGuid();
        var other = Guid.NewGuid();
        var owned = new Repository("a", "o/a", "u", "GitHub", "o", uid);
        var shared = new Repository("b", "o/b", "u", "GitHub", "o", other);

        var mockRepo = new Mock<IRepositoryRepository>();
        mockRepo.Setup(x => x.GetAccessibleByUserIdAsync(uid, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { owned, shared });

        var mockShare = new Mock<IRepositoryShareRepository>();
        mockShare.Setup(x => x.GetSharedWithCountsByRepositoryIdsAsync(
                It.IsAny<IReadOnlyList<Guid>>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new Dictionary<Guid, int> { [owned.Id] = 2 });

        var ownerUser = new User("owner@test.com", "Owner");
        var mockUsers = new Mock<IUserRepository>();
        mockUsers.Setup(x => x.GetByIdAsync(other, It.IsAny<CancellationToken>())).ReturnsAsync(ownerUser);

        var h = new GetRepositoriesByUserIdQueryHandler(mockRepo.Object, mockShare.Object, mockUsers.Object);

        var all = (await h.Handle(new GetRepositoriesByUserIdQuery(uid), default)).ToList();
        all.Should().HaveCount(2);

        var mine = (await h.Handle(new GetRepositoriesByUserIdQuery(uid, RepositoryListFilter.Mine), default)).ToList();
        mine.Should().HaveCount(1);
        mine[0].IsOwner.Should().BeTrue();
        mine[0].SharedWithCount.Should().Be(2);

        var sharedOnly = (await h.Handle(new GetRepositoriesByUserIdQuery(uid, RepositoryListFilter.Shared), default)).ToList();
        sharedOnly.Should().HaveCount(1);
        sharedOnly[0].IsOwner.Should().BeFalse();
        sharedOnly[0].OwnerEmail.Should().Be("owner@test.com");
    }
}

public class GetRepositoriesPaginatedQueryHandlerTests
{
    [Fact]
    public async System.Threading.Tasks.Task Handle_Builds_Page()
    {
        var uid = Guid.NewGuid();
        var r = new Repository("n", "f", "c", "GitHub", "o", uid);
        var mockRepo = new Mock<IRepositoryRepository>();
        mockRepo.Setup(x => x.GetAccessibleByUserIdPaginatedAsync(uid, null, null, 1, 20, It.IsAny<CancellationToken>()))
            .ReturnsAsync(([r], 1));

        var mockShare = new Mock<IRepositoryShareRepository>();
        mockShare.Setup(x => x.GetSharedWithCountsByRepositoryIdsAsync(
                It.IsAny<IReadOnlyList<Guid>>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new Dictionary<Guid, int>());
        var mockUsers = new Mock<IUserRepository>();

        var h = new GetRepositoriesPaginatedQueryHandler(mockRepo.Object, mockShare.Object, mockUsers.Object);
        var result = await h.Handle(new GetRepositoriesPaginatedQuery(uid), default);
        result.Items.Should().HaveCount(1);
        result.TotalCount.Should().Be(1);
    }
}
