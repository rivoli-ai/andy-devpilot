using DevPilot.Application.Services;
using FluentAssertions;
using MediatR;
using Microsoft.Extensions.DependencyInjection;

namespace DevPilot.UnitTests.Application;

public class ApplicationServiceCollectionExtensionsTests
{
    [Fact]
    public async System.Threading.Tasks.Task AddApplication_Registers_Mediator_And_Handlers()
    {
        var services = new ServiceCollection();
        services.AddApplication();
        await using var sp = services.BuildServiceProvider();
        var mediator = sp.GetRequiredService<IMediator>();
        mediator.Should().NotBeNull();
    }
}
