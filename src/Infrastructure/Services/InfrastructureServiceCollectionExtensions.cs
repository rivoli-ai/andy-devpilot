namespace DevPilot.Infrastructure.Services;

using DevPilot.Application.Services;
using DevPilot.Domain.Interfaces;
using DevPilot.Infrastructure.AI;
using DevPilot.Infrastructure.Auth;
using DevPilot.Infrastructure.AzureDevOps;
using DevPilot.Infrastructure.GitHub;
using DevPilot.Infrastructure.Persistence;
using DevPilot.Infrastructure.Zed;
using DevPilot.Infrastructure.ACP;
using DevPilot.Infrastructure.VPS;
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
        // Register DbContext with PostgreSQL
        services.AddDbContext<DevPilotDbContext>((serviceProvider, options) =>
        {
            var config = configuration ?? serviceProvider.GetRequiredService<IConfiguration>();
            var connectionString = config.GetConnectionString("Postgres")
                ?? config["ConnectionStrings:Postgres"]
                ?? "Host=localhost;Port=5432;Database=devpilot;Username=postgres;Password=postgres";
            options.UseNpgsql(connectionString);
        });

        // Register PostgreSQL repository implementations
        services.AddScoped<IRepositoryRepository, PostgresRepositoryRepository>();
        services.AddScoped<IEpicRepository, PostgresEpicRepository>();
        services.AddScoped<IFeatureRepository, PostgresFeatureRepository>();
        services.AddScoped<IUserRepository, PostgresUserRepository>();
        services.AddScoped<IUserStoryRepository, PostgresUserStoryRepository>();
        services.AddScoped<ILinkedProviderRepository, PostgresLinkedProviderRepository>();

        // Register authentication service
        services.AddScoped<AuthenticationService>();

        // Register GitHub service
        services.AddScoped<IGitHubService, GitHubService>();

        // Register Azure DevOps service
        services.AddHttpClient("AzureDevOps");
        services.AddScoped<IAzureDevOpsService, AzureDevOpsService>();

        // Register AI Analysis service
        services.AddScoped<IAnalysisService, AnalysisService>();

        // Register VPS/Zed services (optional - can be enabled via configuration)
        services.AddHttpClient("VPSGateway");
        services.AddScoped<IZedSessionService, ZedSessionService>();
        services.AddScoped<IACPClient, ACPClient>();
        services.AddScoped<IVPSAnalysisService, VPSAnalysisService>();

        return services;
    }
}
