using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using DevPilot.Infrastructure.Services;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace DevPilot.UnitTests.Infrastructure;

public class EffectiveAiConfigResolverTests
{
    [Fact]
    public async System.Threading.Tasks.Task Throws_When_UserMissing()
    {
        var users = new Mock<IUserRepository>();
        users.Setup(x => x.GetByIdAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>())).ReturnsAsync((User?)null);
        var h = new EffectiveAiConfigResolver(
            users.Object,
            Mock.Of<ILlmSettingRepository>(),
            Mock.Of<IRepositoryRepository>(),
            NullLogger<EffectiveAiConfigResolver>.Instance);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            h.GetEffectiveConfigAsync(Guid.NewGuid(), null, default));
    }

    [Fact]
    public async System.Threading.Tasks.Task Uses_RepositoryLlm_When_Set()
    {
        var uid = Guid.NewGuid();
        var user = new User("u@test.dev");
        var llm = new LlmSetting(uid, "n", "openai", "key", "gpt-4", null, isDefault: false);
        var llmId = llm.Id;
        var repo = new Repository("n", "f", "c", "GitHub", "o", uid);
        repo.SetLlmSetting(llmId);

        var users = new Mock<IUserRepository>();
        users.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(user);
        var repos = new Mock<IRepositoryRepository>();
        repos.Setup(x => x.GetByIdAsync(repo.Id, It.IsAny<CancellationToken>())).ReturnsAsync(repo);
        var llms = new Mock<ILlmSettingRepository>();
        llms.Setup(x => x.GetByIdAsync(llmId, It.IsAny<CancellationToken>())).ReturnsAsync(llm);

        var h = new EffectiveAiConfigResolver(users.Object, llms.Object, repos.Object, NullLogger<EffectiveAiConfigResolver>.Instance);
        var cfg = await h.GetEffectiveConfigAsync(uid, repo.Id);
        cfg.Provider.Should().Be("openai");
        cfg.ApiKey.Should().Be("key");
        cfg.Model.Should().Be("gpt-4");
    }

    [Fact]
    public async System.Threading.Tasks.Task Uses_DefaultByUser_When_NoRepoLlm()
    {
        var uid = Guid.NewGuid();
        var user = new User("u@test.dev");
        var def = new LlmSetting(uid, "def", "anthropic", "k2", "claude", null, isDefault: true);

        var users = new Mock<IUserRepository>();
        users.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(user);
        var repos = new Mock<IRepositoryRepository>();
        var llms = new Mock<ILlmSettingRepository>();
        llms.Setup(x => x.GetDefaultByUserIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(def);

        var h = new EffectiveAiConfigResolver(users.Object, llms.Object, repos.Object, NullLogger<EffectiveAiConfigResolver>.Instance);
        var cfg = await h.GetEffectiveConfigAsync(uid, null);
        cfg.Provider.Should().Be("anthropic");
        cfg.ApiKey.Should().Be("k2");
    }

    [Fact]
    public async System.Threading.Tasks.Task Uses_PreferredShared_When_NoDefault()
    {
        var uid = Guid.NewGuid();
        var user = new User("u@test.dev");
        var shared = LlmSetting.CreateShared("shared", "openai", "sk-shared", "gpt", null);
        var sharedId = shared.Id;
        user.SetPreferredSharedLlm(sharedId);

        var users = new Mock<IUserRepository>();
        users.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(user);
        var repos = new Mock<IRepositoryRepository>();
        var llms = new Mock<ILlmSettingRepository>();
        llms.Setup(x => x.GetDefaultByUserIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync((LlmSetting?)null);
        llms.Setup(x => x.GetByIdAsync(sharedId, It.IsAny<CancellationToken>())).ReturnsAsync(shared);

        var h = new EffectiveAiConfigResolver(users.Object, llms.Object, repos.Object, NullLogger<EffectiveAiConfigResolver>.Instance);
        var cfg = await h.GetEffectiveConfigAsync(uid, null);
        cfg.ApiKey.Should().Be("sk-shared");
    }

    [Fact]
    public async System.Threading.Tasks.Task Returns_OpenAiPlaceholder_When_NoLlmFound()
    {
        var uid = Guid.NewGuid();
        var user = new User("u@test.dev");
        var users = new Mock<IUserRepository>();
        users.Setup(x => x.GetByIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync(user);
        var llms = new Mock<ILlmSettingRepository>();
        llms.Setup(x => x.GetDefaultByUserIdAsync(uid, It.IsAny<CancellationToken>())).ReturnsAsync((LlmSetting?)null);

        var h = new EffectiveAiConfigResolver(users.Object, llms.Object, Mock.Of<IRepositoryRepository>(), NullLogger<EffectiveAiConfigResolver>.Instance);
        var empty = await h.GetEffectiveConfigAsync(uid, null);
        empty.Provider.Should().Be("openai");
        empty.ApiKey.Should().BeNull();
        empty.Model.Should().BeNull();
    }
}
