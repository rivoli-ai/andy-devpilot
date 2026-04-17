namespace DevPilot.Infrastructure.Services;

using DevPilot.Application.Options;
using DevPilot.Application.Services;
using DevPilot.Infrastructure.Services;
using DevPilot.Domain.Interfaces;
using DevPilot.Infrastructure.AI;
using DevPilot.Infrastructure.Auth;
using DevPilot.Infrastructure.AzureDevOps;
using DevPilot.Infrastructure.GitHub;
using DevPilot.Infrastructure.Persistence;
using DevPilot.Infrastructure.Zed;
using DevPilot.Infrastructure.ACP;
using DevPilot.Infrastructure.VPS;
using DevPilot.Infrastructure.Sandbox;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Extension methods for configuring Infrastructure layer services
/// </summary>
public static class InfrastructureServiceCollectionExtensions
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration? configuration = null)
    {
        // Register DbContext via the provider switch (PostgreSQL for
        // hosted/Docker, SQLite for embedded Conductor). The active
        // provider is read from `Database:Provider`. `appsettings.json`
        // pins PostgreSql so the historic Docker / dev / Production
        // paths are unchanged; Conductor's embedded launcher overrides
        // via `Database__Provider=Sqlite` env var.
        services.AddDbContext<DevPilotDbContext>((serviceProvider, options) =>
        {
            var config = configuration ?? serviceProvider.GetRequiredService<IConfiguration>();
            var provider = DatabaseProviderExtensions.GetDatabaseProvider(config);
            var connectionString = DatabaseProviderExtensions.ResolveConnectionString(config, provider);
            DatabaseProviderExtensions.ConfigureDbContext(options, provider, connectionString);
        });

        // Register PostgreSQL repository implementations
        services.AddScoped<IRepositoryShareRepository, PostgresRepositoryShareRepository>();
        services.AddScoped<IRepositoryRepository, PostgresRepositoryRepository>();
        services.AddScoped<IRepositoryAgentRuleRepository, PostgresRepositoryAgentRuleRepository>();
        services.AddScoped<IEpicRepository, PostgresEpicRepository>();
        services.AddScoped<IFeatureRepository, PostgresFeatureRepository>();
        services.AddScoped<IUserRepository, PostgresUserRepository>();
        services.AddScoped<IUserStoryRepository, PostgresUserStoryRepository>();
        services.AddScoped<ILinkedProviderRepository, PostgresLinkedProviderRepository>();
        services.AddScoped<ICodeAnalysisRepository, PostgresCodeAnalysisRepository>();
        services.AddScoped<IFileAnalysisRepository, PostgresFileAnalysisRepository>();
        services.AddScoped<ILlmSettingRepository, PostgresLlmSettingRepository>();
        services.AddScoped<IMcpServerConfigRepository, PostgresMcpServerConfigRepository>();
        services.AddScoped<IArtifactFeedConfigRepository, PostgresArtifactFeedConfigRepository>();
        services.AddScoped<IStorySandboxConversationRepository, PostgresStorySandboxConversationRepository>();
        services.AddScoped<IEffectiveAiConfigResolver, EffectiveAiConfigResolver>();

        // Register authentication service
        services.AddScoped<AuthenticationService>();

        // ------------------------------------------------------------------
        // Auth provider registry (configuration-driven)
        // ------------------------------------------------------------------
        if (configuration != null)
        {
            // Bind the AuthProviders config section
            services.Configure<AuthProvidersOptions>(opts =>
            {
                var section = configuration.GetSection(AuthProvidersOptions.SectionName);
                // Bind the section children as the dictionary
                opts.Providers = new Dictionary<string, ProviderConfig>(StringComparer.OrdinalIgnoreCase);
                foreach (var child in section.GetChildren())
                {
                    var pc = new ProviderConfig();
                    child.Bind(pc);
                    opts.Providers[child.Key] = pc;
                }
            });
        }

        // Ensure an HttpClient is available for auth providers
        services.AddHttpClient("AuthProviders");

        // Register the provider registry as singleton
        services.AddSingleton<AuthProviderRegistry>();

        // Register GitHub service
        services.AddScoped<IGitHubService, GitHubService>();

        // Register Azure DevOps service
        services.AddHttpClient("AzureDevOps");
        services.AddScoped<IAzureDevOpsService, AzureDevOpsService>();

        // Register AI Analysis services
        services.AddScoped<IAnalysisService, AnalysisService>();
        services.AddScoped<ICodeAnalysisService, CodeAnalysisService>();
        services.AddHttpClient("LlmConnectivity", client =>
        {
            client.Timeout = TimeSpan.FromSeconds(20);
        });
        services.AddScoped<ILlmConnectivityService, LlmConnectivityService>();

        // Register VPS/Zed services (optional - can be enabled via configuration)
        services.AddHttpClient("VPSGateway");
        services.AddScoped<IZedSessionService, ZedSessionService>();
        services.AddScoped<IACPClient, ACPClient>();
        services.AddScoped<IVPSAnalysisService, VPSAnalysisService>();

        // Register sandbox manager proxy (authenticated via API key).
        // Singleton because SandboxService holds in-memory ownership + credential maps.
        services.AddHttpClient("VPSManager");
        services.AddSingleton<SandboxService>();
        services.AddSingleton<ISandboxService>(sp => sp.GetRequiredService<SandboxService>());

        return services;
    }
}
