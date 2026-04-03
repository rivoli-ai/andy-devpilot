using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using DevPilot.Infrastructure.Persistence;
using FluentAssertions;
using Moq;

namespace DevPilot.UnitTests.Infrastructure;

public class InMemoryRepositoryRepositoryTests
{
    [Fact]
    public async System.Threading.Tasks.Task Crud_And_Lookup_ByFullName()
    {
        var db = new InMemoryRepositoryRepository();
        var u = Guid.NewGuid();
        var r = new Repository("a", "org/a", "http://c", "GitHub", "org", u);
        await db.AddAsync(r);
        (await db.GetByIdAsync(r.Id)).Should().BeSameAs(r);
        (await db.GetByIdTrackedAsync(r.Id)).Should().BeSameAs(r);
        (await db.ExistsAsync(r.Id)).Should().BeTrue();
        var list = (await db.GetByUserIdAsync(u)).ToList();
        list.Should().ContainSingle();
        (await db.GetByFullNameAndProviderAsync("org/a", "GitHub")).Should().BeSameAs(r);
        (await db.GetByFullNameProviderAndUserIdAsync("org/a", "GitHub", u)).Should().BeSameAs(r);
        (await db.DeleteAsync(r.Id)).Should().BeTrue();
        (await db.GetByIdAsync(r.Id)).Should().BeNull();
    }

    [Fact]
    public async System.Threading.Tasks.Task GetByUserIdPaginated_Search_And_Page()
    {
        var db = new InMemoryRepositoryRepository();
        var u = Guid.NewGuid();
        await db.AddAsync(new Repository("zebra", "o/z", "c", "GitHub", "o", u));
        await db.AddAsync(new Repository("alpha", "o/a", "c", "GitHub", "o", u));
        var (items, total) = await db.GetByUserIdPaginatedAsync(u, search: "alp", page: 1, pageSize: 10);
        total.Should().Be(1);
        items.Should().ContainSingle().Which.Name.Should().Be("alpha");
    }

    [Fact]
    public async System.Threading.Tasks.Task GetAccessible_Uses_ShareRepository()
    {
        var owner = Guid.NewGuid();
        var guest = Guid.NewGuid();
        var r = new Repository("x", "o/x", "c", "GitHub", "o", owner);
        var shareMock = new Mock<IRepositoryShareRepository>();
        shareMock.Setup(x => x.GetRepositoryIdsSharedWithUserAsync(guest, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { r.Id });
        shareMock.Setup(x => x.ExistsAsync(r.Id, guest, It.IsAny<CancellationToken>())).ReturnsAsync(true);
        var db = new InMemoryRepositoryRepository(shareMock.Object);
        await db.AddAsync(r);
        (await db.GetAccessibleByUserIdAsync(guest)).Should().ContainSingle();
        (await db.GetByIdIfAccessibleAsync(r.Id, guest)).Should().BeSameAs(r);
    }

    [Fact]
    public async System.Threading.Tasks.Task GetByIdIfAccessible_Requires_Share_WhenNotOwner()
    {
        var owner = Guid.NewGuid();
        var guest = Guid.NewGuid();
        var r = new Repository("x", "o/x", "c", "GitHub", "o", owner);
        var shareMock = new Mock<IRepositoryShareRepository>();
        shareMock.Setup(x => x.ExistsAsync(r.Id, guest, It.IsAny<CancellationToken>())).ReturnsAsync(true);
        var db = new InMemoryRepositoryRepository(shareMock.Object);
        await db.AddAsync(r);
        (await db.GetByIdIfAccessibleAsync(r.Id, guest)).Should().BeSameAs(r);
    }

    [Fact]
    public async System.Threading.Tasks.Task GetAccessiblePaginated_Filters_Mine_And_Shared()
    {
        var owner = Guid.NewGuid();
        var other = Guid.NewGuid();
        var guest = Guid.NewGuid();
        var mine = new Repository("m", "o/m", "c", "GitHub", "o", owner);
        var theirs = new Repository("t", "o/t", "c", "GitHub", "o", other);
        var shareMock = new Mock<IRepositoryShareRepository>();
        shareMock.Setup(x => x.GetRepositoryIdsSharedWithUserAsync(guest, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { theirs.Id });
        var db = new InMemoryRepositoryRepository(shareMock.Object);
        await db.AddAsync(mine);
        await db.AddAsync(theirs);

        var mineOnly = await db.GetAccessibleByUserIdPaginatedAsync(guest, filter: "mine", page: 1, pageSize: 10);
        mineOnly.TotalCount.Should().Be(0);

        var sharedOnly = (await db.GetAccessibleByUserIdPaginatedAsync(guest, filter: "shared", page: 1, pageSize: 10)).Items.ToList();
        sharedOnly.Should().ContainSingle().Which.Id.Should().Be(theirs.Id);
    }
}
