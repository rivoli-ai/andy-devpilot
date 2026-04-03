using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Primitives;
using AuthenticationService = DevPilot.Infrastructure.Auth.AuthenticationService;

namespace DevPilot.UnitTests.Infrastructure;

internal sealed class DictionaryConfiguration : IConfiguration
{
    private readonly Dictionary<string, string?> _data;
    public DictionaryConfiguration(IEnumerable<KeyValuePair<string, string?>> data) =>
        _data = new Dictionary<string, string?>(data, StringComparer.OrdinalIgnoreCase);

    public string? this[string key]
    {
        get => _data.TryGetValue(key, out var v) ? v : null;
        set { if (value != null) _data[key] = value; else _data.Remove(key); }
    }

    public IConfigurationSection GetSection(string key) =>
        throw new NotSupportedException();

    public IEnumerable<IConfigurationSection> GetChildren() =>
        Array.Empty<IConfigurationSection>();

    public IChangeToken GetReloadToken() => new CancellationChangeToken(CancellationToken.None);
}

public class AuthenticationServiceTests
{
    private static AuthenticationService CreateSut(IEnumerable<KeyValuePair<string, string?>>? pairs = null)
    {
        var data = pairs ?? new Dictionary<string, string?> {
            ["JWT:SecretKey"] = new string('x', 64),
            ["JWT:Issuer"] = "TestIssuer",
            ["JWT:Audience"] = "TestAudience"
        };
        return new AuthenticationService(new DictionaryConfiguration(data));
    }

    [Fact]
    public void GenerateToken_Includes_Subject_Email_And_AdminRole()
    {
        var sut = CreateSut();
        var uid = Guid.NewGuid();
        var jwt = sut.GenerateToken(uid, "a@b.com", isAdmin: true);
        var handler = new JwtSecurityTokenHandler();
        var t = handler.ReadJwtToken(jwt);
        t.Claims.Should().Contain(c => c.Value == "a@b.com" && (c.Type == "email" || c.Type == ClaimTypes.Email));
        t.Claims.Should().Contain(c => c.Value == uid.ToString());
        t.Claims.Should().Contain(c => c.Value == "admin" && (c.Type == "role" || c.Type == ClaimTypes.Role));
    }

    [Fact]
    public void HashPassword_And_Verify_RoundTrip()
    {
        var sut = CreateSut();
        var hash = sut.HashPassword("Secret123");
        sut.VerifyPassword("Secret123", hash).Should().BeTrue();
        sut.VerifyPassword("Wrong", hash).Should().BeFalse();
    }

    [Fact]
    public void VerifyPassword_ReturnsFalse_On_InvalidHash()
    {
        var sut = CreateSut();
        sut.VerifyPassword("x", "not-a-bcrypt-hash").Should().BeFalse();
    }

    [Theory]
    [InlineData("", "required")]
    [InlineData("short", "8 characters")]
    [InlineData("lowercase123", "uppercase")]
    [InlineData("UPPERCASE123", "lowercase")]
    [InlineData("NoDigitsAa", "number")]
    public void ValidatePassword_Rules(string pwd, string expectedFragment)
    {
        var sut = CreateSut();
        var (ok, err) = sut.ValidatePassword(pwd);
        ok.Should().BeFalse();
        err.Should().Contain(expectedFragment);
    }

    [Fact]
    public void ValidatePassword_Accepts_Strong_Password()
    {
        var sut = CreateSut();
        var (ok, err) = sut.ValidatePassword("Aa1bbbbbb");
        ok.Should().BeTrue();
        err.Should().BeNull();
    }

    [Fact]
    public void Constructor_Throws_When_SecretMissing()
    {
        Assert.Throws<InvalidOperationException>(() => CreateSut(Array.Empty<KeyValuePair<string, string?>>()));
    }
}
