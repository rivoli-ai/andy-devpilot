using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Infrastructure.AI;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace DevPilot.UnitTests.Infrastructure;

public class LlmConnectivityServiceTests
{
    [Fact]
    public async System.Threading.Tasks.Task Unknown_Provider_Returns_Error_Without_Http()
    {
        var s = new LlmSetting(Guid.NewGuid(), "n", "weird", "k", "m", null);
        var svc = new LlmConnectivityService(Mock.Of<IHttpClientFactory>(), NullLogger<LlmConnectivityService>.Instance);
        var r = await svc.TestAsync(s);
        r.Ok.Should().BeFalse();
        r.ErrorMessage.Should().Contain("Unknown");
    }

    [Fact]
    public async System.Threading.Tasks.Task OpenAi_Without_Key_Fails()
    {
        var s = new LlmSetting(Guid.NewGuid(), "n", "openai", "", "gpt", null);
        var svc = new LlmConnectivityService(Mock.Of<IHttpClientFactory>(), NullLogger<LlmConnectivityService>.Instance);
        var r = await svc.TestAsync(s);
        r.Ok.Should().BeFalse();
        r.ErrorMessage.Should().Contain("API key");
    }

    [Fact]
    public async System.Threading.Tasks.Task Anthropic_Without_Key_Fails()
    {
        var s = new LlmSetting(Guid.NewGuid(), "n", "anthropic", null, "claude", null);
        var svc = new LlmConnectivityService(Mock.Of<IHttpClientFactory>(), NullLogger<LlmConnectivityService>.Instance);
        var r = await svc.TestAsync(s);
        r.Ok.Should().BeFalse();
    }

    [Fact]
    public async System.Threading.Tasks.Task Custom_Without_BaseUrl_Fails()
    {
        var s = new LlmSetting(Guid.NewGuid(), "n", "custom", "k", "m", null);
        var svc = new LlmConnectivityService(Mock.Of<IHttpClientFactory>(), NullLogger<LlmConnectivityService>.Instance);
        var r = await svc.TestAsync(s);
        r.Ok.Should().BeFalse();
        r.ErrorMessage.Should().Contain("base URL");
    }
}
