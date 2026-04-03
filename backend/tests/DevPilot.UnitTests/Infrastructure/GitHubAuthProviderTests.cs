using System.Net;
using DevPilot.Application.Options;
using DevPilot.Infrastructure.Auth;
using FluentAssertions;
using Moq;

namespace DevPilot.UnitTests.Infrastructure;

public class GitHubAuthProviderTests
{
    [Fact]
    public void BuildAuthorizationUrl_Includes_Scopes_State_Client()
    {
        var cfg = new ProviderConfig {
            ClientId = "cid",
            RedirectUri = "http://localhost/cb",
            Scopes = "repo"
        };
        var p = new GitHubAuthProvider(cfg, Mock.Of<IHttpClientFactory>());
        var url = p.BuildAuthorizationUrl("state123");
        url.Should().StartWith("https://github.com/login/oauth/authorize?");
        url.Should().Contain("client_id=cid");
        url.Should().Contain("redirect_uri=");
        url.Should().Contain("scope=repo");
        url.Should().Contain("state=state123");
    }

    [Fact]
    public async System.Threading.Tasks.Task ExchangeCodeAsync_ParsesJsonAccessToken()
    {
        var cfg = new ProviderConfig {
            ClientId = "cid",
            ClientSecret = "sec",
            RedirectUri = "http://localhost/cb"
        };
        var handler = new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) {
            Content = new StringContent("{\"access_token\":\"gho_tok\"}", System.Text.Encoding.UTF8, "application/json")
        });
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(new HttpClient(handler));

        var p = new GitHubAuthProvider(cfg, factory.Object);
        var r = await p.ExchangeCodeAsync("code", "http://localhost/cb", default);
        r.AccessToken.Should().Be("gho_tok");
    }

    [Fact]
    public async System.Threading.Tasks.Task ExchangeCodeAsync_ParsesFormEncodedAccessToken()
    {
        var cfg = new ProviderConfig {
            ClientId = "cid",
            ClientSecret = "sec",
            RedirectUri = "http://localhost/cb"
        };
        var handler = new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) {
            Content = new StringContent("access_token=formtok&scope=repo", System.Text.Encoding.UTF8, "application/x-www-form-urlencoded")
        });
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(new HttpClient(handler));

        var p = new GitHubAuthProvider(cfg, factory.Object);
        var r = await p.ExchangeCodeAsync("code", "", default);
        r.AccessToken.Should().Be("formtok");
    }

    [Fact]
    public async System.Threading.Tasks.Task ExchangeCodeAsync_Throws_When_No_AccessToken_In_200_Response()
    {
        var cfg = new ProviderConfig { ClientId = "cid", ClientSecret = "sec", RedirectUri = "http://localhost/cb" };
        var handler = new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) {
            Content = new StringContent("{\"error\":\"bad\"}", System.Text.Encoding.UTF8, "application/json")
        });
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(new HttpClient(handler));
        var p = new GitHubAuthProvider(cfg, factory.Object);
        await Assert.ThrowsAsync<InvalidOperationException>(() => p.ExchangeCodeAsync("c", "http://localhost/cb", default));
    }

    [Fact]
    public async System.Threading.Tasks.Task ExchangeCodeAsync_Throws_On_ErrorStatus()
    {
        var cfg = new ProviderConfig { ClientId = "c", ClientSecret = "s", RedirectUri = "http://x" };
        var handler = new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.BadRequest) {
            Content = new StringContent("no")
        });
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(new HttpClient(handler));
        var p = new GitHubAuthProvider(cfg, factory.Object);
        await Assert.ThrowsAsync<InvalidOperationException>(() => p.ExchangeCodeAsync("c", "http://x", default));
    }

    private sealed class StubHttpMessageHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _respond;
        public StubHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) => _respond = respond;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(_respond(request));
    }
}
