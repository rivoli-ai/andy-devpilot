using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using DevPilot.Application.Options;
using DevPilot.Infrastructure.Auth;
using FluentAssertions;
using Microsoft.IdentityModel.Tokens;
using Moq;

namespace DevPilot.UnitTests.Infrastructure;

public class OidcAuthProviderTests
{
    [Fact]
    public void BuildAuthorizationUrl_Is_Null()
    {
        var cfg = new ProviderConfig { Authority = "http://127.0.0.1:9", ClientId = "cid" };
        var p = new OidcAuthProvider("D", cfg, Mock.Of<IHttpClientFactory>());
        p.BuildAuthorizationUrl("s").Should().BeNull();
        p.Type.Should().Be("FrontendOidc");
    }

    [Fact]
    public async System.Threading.Tasks.Task ExchangeCode_Throws_NotSupported()
    {
        var cfg = new ProviderConfig { Authority = "http://127.0.0.1:9", ClientId = "cid" };
        var p = new OidcAuthProvider("D", cfg, Mock.Of<IHttpClientFactory>());
        await Assert.ThrowsAsync<NotSupportedException>(() => p.ExchangeCodeAsync("c", "r", default));
    }

    [Fact]
    public async System.Threading.Tasks.Task GetUserProfileAsync_Reads_Jwt_When_NoProfileEndpoint()
    {
        var cfg = new ProviderConfig { Authority = "http://127.0.0.1:9", ClientId = "cid", ProfileEndpoint = null };
        var p = new OidcAuthProvider("D", cfg, Mock.Of<IHttpClientFactory>());

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes("0123456789abcdef0123456789abcdef"));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
        var jwt = new JwtSecurityToken(
            claims: new[] {
                new Claim("sub", "user-1"),
                new Claim("email", "e@example.com"),
                new Claim("name", "N")
            },
            signingCredentials: creds);
        var token = new JwtSecurityTokenHandler().WriteToken(jwt);

        var profile = await p.GetUserProfileAsync(token, default);
        profile.ProviderUserId.Should().Be("user-1");
        profile.Email.Should().Be("e@example.com");
        profile.DisplayName.Should().Be("N");
    }
}