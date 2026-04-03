using DevPilot.Domain.Entities;
using FluentAssertions;

namespace DevPilot.UnitTests.Domain;

public class DomainEntityTests
{
    [Fact]
    public void Entity_MarkAsUpdated_SetsUpdatedAt()
    {
        var e = new TestEntity();
        e.UpdatedAt.Should().BeNull();
        e.Touch();
        e.UpdatedAt.Should().NotBeNull();
    }

    private sealed class TestEntity : Entity
    {
        public void Touch() => MarkAsUpdated();
    }
}

public class UserTests
{
    [Fact]
    public void CreateWithPassword_SetsHash()
    {
        var u = User.CreateWithPassword("a@b.com", "hash", "N");
        u.Email.Should().Be("a@b.com");
        u.HasPassword().Should().BeTrue();
    }

    [Fact]
    public void VerifyEmail_And_Clearing()
    {
        var u = new User("x@y.com");
        u.EmailVerified.Should().BeFalse();
        u.VerifyEmail();
        u.EmailVerified.Should().BeTrue();
        u.UpdateName("Z");
        u.UpdateGitHubToken("t", DateTime.UtcNow.AddHours(1));
        u.UpdateAzureDevOpsSettings("org", "tok");
        u.ClearAzureDevOpsSettings();
        u.AzureDevOpsOrganization.Should().BeNull();
        u.SetPreferredSharedLlm(Guid.NewGuid());
    }

    [Fact]
    public void NullEmail_Throws() =>
        Assert.Throws<ArgumentNullException>(() => new User(null!));
}

public class RepositoryTests
{
    [Fact]
    public void Update_And_Identity()
    {
        var uid = Guid.NewGuid();
        var r = new Repository("n", "fn", "https://g", "GitHub", "o", uid);
        r.UpdateDescription("d");
        r.UpdateDefaultBranch("main");
        r.SetLlmSetting(Guid.NewGuid());
        r.UpdateAgentRules("rules");
        r.UpdateAzureIdentity("cid", "sec", "tid");
        r.AzureIdentityClientId.Should().Be("cid");
    }
}

public class EpicFeatureStoryTaskTests
{
    [Fact]
    public void Epic_Lifecycle()
    {
        var repo = Guid.NewGuid();
        var e = new Epic("E", repo, "d", "AzureDevOps", 5);
        e.Source.Should().Be("AzureDevOps");
        e.UpdateTitle("E2");
        e.ChangeStatus("Done");
        e.SetAzureDevOpsWorkItemId(null);
        Assert.Throws<ArgumentException>(() => e.ChangeStatus(" "));
    }

    [Fact]
    public void Feature_Lifecycle()
    {
        var eid = Guid.NewGuid();
        var f = new Feature("F", eid, source: "GitHub", githubIssueNumber: 99);
        f.SetGitHubIssueNumber(100);
        f.ChangeStatus("InProgress");
    }

    [Fact]
    public void UserStory_Lifecycle()
    {
        var fid = Guid.NewGuid();
        var us = new UserStory("S", fid, storyPoints: 3);
        us.SetStoryPoints(5);
        us.ChangeStatus("Done", "https://pr");
        us.SetPrUrl(null);
    }

    [Fact]
    public void Task_Lifecycle()
    {
        var sid = Guid.NewGuid();
        var t = new DevPilot.Domain.Entities.Task("T", sid, "Simple");
        t.ChangeComplexity("Complex");
        t.AssignTo("me");
        Assert.Throws<ArgumentNullException>(() => new DevPilot.Domain.Entities.Task(null!, sid));
    }
}

public class LlmAndMcpTests
{
    [Fact]
    public void LlmSetting_Personal_And_Shared()
    {
        var p = new LlmSetting(Guid.NewGuid(), "n", "openai", "k", "m", null, true);
        p.IsShared.Should().BeFalse();
        var s = LlmSetting.CreateShared("sn", "anthropic", null, "m2", "http://x");
        s.IsShared.Should().BeTrue();
        s.Update("x", "key", "m3", "url", "custom");
        s.SetDefault(false);
    }

    [Fact]
    public void McpServerConfig_Validation()
    {
        var m = new McpServerConfig(Guid.NewGuid(), "n", "stdio", "c", "[]", "{}", null, null);
        Assert.Throws<ArgumentException>(() => new McpServerConfig(Guid.NewGuid(), "n", "bad", null, null, null, null, null));
        var sh = McpServerConfig.CreateShared("s", "remote", null, null, null, "http://u", "{}");
        sh.Update("a", "remote", "cmd", null, null, null, null);
        sh.SetEnabled(false);
    }

    [Fact]
    public void ArtifactFeedConfig_Validation()
    {
        var a = new ArtifactFeedConfig("n", "org", "feed", "proj", "npm");
        Assert.Throws<ArgumentException>(() => new ArtifactFeedConfig("n", "o", "f", null, "bad"));
        a.Update("n2", null, null, null, "pip");
        a.SetEnabled(true);
    }
}

public class LinkedProviderAndShareTests
{
    [Fact]
    public void LinkedProvider_Token()
    {
        var lp = new LinkedProvider(Guid.NewGuid(), "GitHub", "pid", "tok");
        lp.UpdateToken("t2", "r", DateTime.UtcNow.AddDays(1));
        lp.IsTokenExpired().Should().BeFalse();
        var expired = new LinkedProvider(Guid.NewGuid(), "GitHub", "p", "t", tokenExpiresAt: DateTime.UtcNow.AddSeconds(-1));
        expired.IsTokenExpired().Should().BeTrue();
        ProviderTypes.GitHub.Should().Be("GitHub");
    }

    [Fact]
    public void RepositoryShare_Ctor()
    {
        var s = new RepositoryShare(Guid.NewGuid(), Guid.NewGuid());
        s.RepositoryId.Should().NotBe(Guid.Empty);
    }
}

public class AnalysisEntityTests
{
    [Fact]
    public void CodeAnalysis_Update()
    {
        var rid = Guid.NewGuid();
        var c = new CodeAnalysis(rid, "main", "sum", "arch");
        c.Update("s2", model: "gpt");
    }

    [Fact]
    public void FileAnalysis_Update()
    {
        var rid = Guid.NewGuid();
        var f = new FileAnalysis(rid, "a.cs", "main", "exp");
        f.Update("e2", complexity: "high");
    }
}
