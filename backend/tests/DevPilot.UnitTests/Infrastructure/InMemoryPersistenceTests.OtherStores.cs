using DevPilot.Domain.Entities;
using DevPilot.Infrastructure.Persistence;
using FluentAssertions;

namespace DevPilot.UnitTests.Infrastructure;

public class InMemoryEpicRepositoryTests
{
    [Fact]
    public async System.Threading.Tasks.Task Epic_Crud()
    {
        var db = new InMemoryEpicRepository();
        var repoId = Guid.NewGuid();
        var e = new Epic("E", repoId);
        await db.AddAsync(e);
        (await db.GetByIdAsync(e.Id)).Should().BeSameAs(e);
        (await db.GetByRepositoryIdAsync(repoId)).Should().ContainSingle();
        await db.UpdateAsync(e);
        await db.DeleteAsync(e);
        (await db.GetByIdAsync(e.Id)).Should().BeNull();
    }
}

public class InMemoryUserRepositoryTests
{
    [Fact]
    public async System.Threading.Tasks.Task User_Search_Add_Update()
    {
        var db = new InMemoryUserRepository();
        var u = new User("alice@test.dev", "Alice");
        await db.AddAsync(u);
        (await db.GetByEmailAsync("ALICE@test.dev")).Should().BeSameAs(u);
        (await db.GetByIdAsync(u.Id)).Should().BeSameAs(u);
        var found = await db.SearchSuggestionsAsync("ali", 5, null);
        found.Should().ContainSingle();
        u.VerifyEmail();
        await db.UpdateAsync(u);
        (await db.GetByIdAsync(u.Id))!.EmailVerified.Should().BeTrue();
    }

    [Fact]
    public async System.Threading.Tasks.Task SearchSuggestions_RespectsLimit_And_Exclude()
    {
        var db = new InMemoryUserRepository();
        var a = new User("a1@x.com");
        var b = new User("a2@x.com");
        await db.AddAsync(a);
        await db.AddAsync(b);
        (await db.SearchSuggestionsAsync("a", 1, null)).Should().HaveCount(1);
        (await db.SearchSuggestionsAsync("", 5, null)).Should().BeEmpty();
        (await db.SearchSuggestionsAsync("a2", 5, a.Id)).Should().ContainSingle().Which.Id.Should().Be(b.Id);
    }
}

public class InMemoryUserStoryRepositoryTests
{
    [Fact]
    public async System.Threading.Tasks.Task Story_Crud()
    {
        var db = new InMemoryUserStoryRepository();
        var s = new UserStory("S", Guid.NewGuid());
        await db.AddAsync(s);
        (await db.GetByIdAsync(s.Id)).Should().BeSameAs(s);
        await db.UpdateAsync(s);
        await db.DeleteAsync(s);
        (await db.GetByIdAsync(s.Id)).Should().BeNull();
    }
}
