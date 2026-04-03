using DevPilot.Application.Options;
using DevPilot.Infrastructure.Auth;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Moq;

namespace DevPilot.UnitTests.Infrastructure;

public class LocalAuthProviderTests
{
    [Fact]
    public void Metadata_And_Unsupported()
    {
        var p = new LocalAuthProvider();
        p.Name.Should().Be("Local");
        p.Type.Should().Be("Local");
        p.BuildAuthorizationUrl().Should().BeNull();
        Assert.Throws<NotSupportedException>(() => p.ExchangeCodeAsync("c", "u", default).GetAwaiter().GetResult());
        Assert.Throws<NotSupportedException>(() => p.ValidateTokenAsync("t", default).GetAwaiter().GetResult());
        Assert.Throws<NotSupportedException>(() => p.GetUserProfileAsync("t", default).GetAwaiter().GetResult());
    }
}

public class AuthProviderRegistryTests
{
    [Fact]
    public void Registers_Local_And_Resolves()
    {
        var options = Options.Create(new AuthProvidersOptions {
            Providers = new Dictionary<string, ProviderConfig>(StringComparer.OrdinalIgnoreCase) {
                ["Local"] = new ProviderConfig { Enabled = true, Type = "Local" }
            }
        });
        var factory = new Mock<IHttpClientFactory>();
        var logger = new Mock<ILogger<AuthProviderRegistry>>();
        var reg = new AuthProviderRegistry(options, factory.Object, logger.Object);
        reg.IsEnabled("Local").Should().BeTrue();
        reg.GetProvider("Local").Should().NotBeNull();
    }

    [Fact]
    public void Disabled_Skipped()
    {
        var options = Options.Create(new AuthProvidersOptions {
            Providers = new Dictionary<string, ProviderConfig>(StringComparer.OrdinalIgnoreCase) {
                ["X"] = new ProviderConfig { Enabled = false, Type = "Local" }
            }
        });
        var reg = new AuthProviderRegistry(options, Mock.Of<IHttpClientFactory>(), Mock.Of<ILogger<AuthProviderRegistry>>());
        reg.IsEnabled("X").Should().BeFalse();
    }

    [Fact]
    public void DangerousCert_LogsWarning()
    {
        var options = Options.Create(new AuthProvidersOptions {
            Providers = new Dictionary<string, ProviderConfig>(StringComparer.OrdinalIgnoreCase) {
                ["Duende"] = new ProviderConfig {
                    Enabled = true,
                    Type = "FrontendOidc",
                    Authority = "https://login.example.invalid",
                    DangerousAcceptAnyServerCertificate = true
                }
            }
        });
        var logger = new Mock<ILogger<AuthProviderRegistry>>();
        _ = new AuthProviderRegistry(options, Mock.Of<IHttpClientFactory>(), logger.Object);
        logger.Verify(
            x => x.Log(
                LogLevel.Warning,
                It.IsAny<EventId>(),
                It.Is<It.IsAnyType>((o, _) => o.ToString()!.Contains("DangerousAcceptAnyServerCertificate", StringComparison.Ordinal)),
                It.IsAny<Exception?>(),
                It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
            Times.AtLeastOnce);
    }

    [Fact]
    public void Unknown_Type_Throws()
    {
        var options = Options.Create(new AuthProvidersOptions {
            Providers = new Dictionary<string, ProviderConfig>(StringComparer.OrdinalIgnoreCase) {
                ["Bad"] = new ProviderConfig { Enabled = true, Type = "Nope" }
            }
        });
        Assert.Throws<InvalidOperationException>(() =>
            new AuthProviderRegistry(options, Mock.Of<IHttpClientFactory>(), Mock.Of<ILogger<AuthProviderRegistry>>()));
    }

    [Fact]
    public void Registers_GitHub_BackendOAuth()
    {
        var options = Options.Create(new AuthProvidersOptions {
            Providers = new Dictionary<string, ProviderConfig>(StringComparer.OrdinalIgnoreCase) {
                ["GitHub"] = new ProviderConfig {
                    Enabled = true,
                    Type = "BackendOAuth",
                    ClientId = "id",
                    ClientSecret = "sec",
                    RedirectUri = "http://localhost/cb"
                }
            }
        });
        var reg = new AuthProviderRegistry(options, Mock.Of<IHttpClientFactory>(), Mock.Of<ILogger<AuthProviderRegistry>>());
        reg.GetProvider("GitHub").Should().BeOfType<GitHubAuthProvider>();
    }

    [Fact]
    public void BackendOAuth_NonGitHub_Throws()
    {
        var options = Options.Create(new AuthProvidersOptions {
            Providers = new Dictionary<string, ProviderConfig>(StringComparer.OrdinalIgnoreCase) {
                ["Other"] = new ProviderConfig { Enabled = true, Type = "BackendOAuth" }
            }
        });
        Assert.Throws<InvalidOperationException>(() =>
            new AuthProviderRegistry(options, Mock.Of<IHttpClientFactory>(), Mock.Of<ILogger<AuthProviderRegistry>>()));
    }

    [Fact]
    public void GetProvider_Throws_When_Missing()
    {
        var options = Options.Create(new AuthProvidersOptions { Providers = new() });
        var reg = new AuthProviderRegistry(options, Mock.Of<IHttpClientFactory>(), Mock.Of<ILogger<AuthProviderRegistry>>());
        Assert.Throws<InvalidOperationException>(() => reg.GetProvider("None"));
        reg.TryGetProvider("None", out var p).Should().BeFalse();
        p.Should().BeNull();
    }

    [Fact]
    public void GetEnabledProviders_Returns_Registered()
    {
        var options = Options.Create(new AuthProvidersOptions {
            Providers = new Dictionary<string, ProviderConfig>(StringComparer.OrdinalIgnoreCase) {
                ["Local"] = new ProviderConfig { Enabled = true, Type = "Local" }
            }
        });
        var reg = new AuthProviderRegistry(options, Mock.Of<IHttpClientFactory>(), Mock.Of<ILogger<AuthProviderRegistry>>());
        reg.GetEnabledProviders().Should().NotBeEmpty();
    }
}

public class AuthProvidersOptionsTests
{
    [Fact]
    public void GetEnabledProviders_Filters()
    {
        var o = new AuthProvidersOptions {
            Providers = new() {
                ["A"] = new ProviderConfig { Enabled = true },
                ["B"] = new ProviderConfig { Enabled = false }
            }
        };
        o.GetEnabledProviders().Should().HaveCount(1);
    }
}
