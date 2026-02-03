namespace DevPilot.Application.Services;

using System.Reflection;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Extension methods for configuring Application layer services
/// </summary>
public static class ApplicationServiceCollectionExtensions
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        // Register MediatR with the current assembly to discover handlers
        services.AddMediatR(cfg => cfg.RegisterServicesFromAssembly(Assembly.GetExecutingAssembly()));

        return services;
    }
}
