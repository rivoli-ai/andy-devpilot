namespace DevPilot.Infrastructure.Auth;

using DevPilot.Application.Options;
using DevPilot.Application.Services;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

/// <summary>
/// Singleton registry that holds all enabled <see cref="IAuthProvider"/> instances.
/// Built from <see cref="AuthProvidersOptions"/> at startup.
/// </summary>
public class AuthProviderRegistry
{
    private readonly Dictionary<string, IAuthProvider> _providers = new(StringComparer.OrdinalIgnoreCase);
    private readonly AuthProvidersOptions _options;

    public AuthProviderRegistry(
        IOptions<AuthProvidersOptions> options,
        IHttpClientFactory httpClientFactory,
        IHostEnvironment hostEnvironment,
        ILogger<AuthProviderRegistry> logger)
    {
        _options = options.Value;

        foreach (var (name, config) in _options.Providers)
        {
            if (!config.Enabled)
            {
                logger.LogInformation("Auth provider '{Provider}' is disabled.", name);
                continue;
            }

            IAuthProvider provider = config.Type?.ToLowerInvariant() switch
            {
                "local" or null or "" => new LocalAuthProvider(),
                "backendoauth" => CreateBackendOAuthProvider(name, config, httpClientFactory),
                "frontendoidc" => new OidcAuthProvider(name, config, httpClientFactory, hostEnvironment),
                _ => throw new InvalidOperationException($"Unknown auth provider type '{config.Type}' for provider '{name}'.")
            };

            _providers[name] = provider;
            logger.LogInformation("Auth provider '{Provider}' ({Type}) registered.", name, config.Type ?? "Local");
        }
    }

    /// <summary>Get an enabled provider by name. Throws if not found or disabled.</summary>
    public IAuthProvider GetProvider(string name)
    {
        if (_providers.TryGetValue(name, out var provider))
            return provider;

        throw new InvalidOperationException($"Auth provider '{name}' is not enabled or does not exist.");
    }

    /// <summary>Try to get a provider; returns false if not registered.</summary>
    public bool TryGetProvider(string name, out IAuthProvider? provider)
        => _providers.TryGetValue(name, out provider);

    /// <summary>Check whether a provider is enabled.</summary>
    public bool IsEnabled(string name) => _providers.ContainsKey(name);

    /// <summary>All enabled providers.</summary>
    public IReadOnlyCollection<IAuthProvider> GetEnabledProviders() => _providers.Values;

    /// <summary>The raw options (for building frontend config responses).</summary>
    public AuthProvidersOptions Options => _options;

    // ---- factory helpers ----

    private static IAuthProvider CreateBackendOAuthProvider(string name, ProviderConfig config, IHttpClientFactory httpClientFactory)
    {
        // Currently only GitHub is BackendOAuth; add more cases if needed.
        if (name.Equals("GitHub", StringComparison.OrdinalIgnoreCase))
            return new GitHubAuthProvider(config, httpClientFactory);

        throw new InvalidOperationException($"No BackendOAuth provider implementation for '{name}'.");
    }
}
