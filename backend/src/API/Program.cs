using System.Text;
using DevPilot.API.Hubs;
using DevPilot.Application.Services;
using DevPilot.Infrastructure.Persistence;
using DevPilot.Infrastructure.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

ConfigureServices(builder);

var app = builder.Build();

ApplyDatabaseSchema(app);

ConfigureHttpPipeline(app);

app.Run();

// ---------------------------------------------------------------------------
// Service registration
// ---------------------------------------------------------------------------

static void ConfigureServices(WebApplicationBuilder builder)
{
    builder.Services.AddControllers();
    builder.Services.AddHttpContextAccessor();
    builder.Services.AddHttpClient();
    builder.Services.AddMemoryCache();
    builder.Services.AddOpenApi();
    builder.Services.AddSignalR();

    ConfigureJwtAuthentication(builder);

    builder.Services.AddAuthorization(options =>
        options.AddPolicy("Admin", policy => policy.RequireRole("admin")));

    builder.Services.AddApplication();
    builder.Services.AddInfrastructure(builder.Configuration);

    ConfigureCors(builder);
}

static void ConfigureJwtAuthentication(WebApplicationBuilder builder)
{
    var secretKey = builder.Configuration["JWT:SecretKey"];
    if (string.IsNullOrWhiteSpace(secretKey))
    {
        if (!builder.Environment.IsDevelopment())
            throw new InvalidOperationException(
                "JWT:SecretKey must be configured via configuration or environment variables.");
        secretKey = "dev-secret-key-min-32-characters-long-for-security";
    }

    var key = Encoding.ASCII.GetBytes(secretKey);

    builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
        .AddJwtBearer(options =>
        {
            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = new SymmetricSecurityKey(key),
                ValidateIssuer = true,
                ValidIssuer = builder.Configuration["JWT:Issuer"] ?? "DevPilot",
                ValidateAudience = true,
                ValidAudience = builder.Configuration["JWT:Audience"] ?? "DevPilot",
                ValidateLifetime = true,
                ClockSkew = TimeSpan.Zero
            };
        });
}

/// <summary>
/// Allowed browser origins for SPA + SignalR (credentials). Configure via
/// <c>Cors:AllowedOrigins</c> in appsettings or <c>Cors__AllowedOrigins__0</c> env vars.
/// </summary>
static void ConfigureCors(WebApplicationBuilder builder)
{
    var origins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
                  ?? Array.Empty<string>();

    builder.Services.AddCors(options =>
    {
        options.AddDefaultPolicy(policy =>
        {
            if (origins.Length > 0)
            {
                policy.WithOrigins(origins)
                    .AllowAnyMethod()
                    .AllowAnyHeader()
                    .AllowCredentials();
            }
        });
    });
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/// <summary>
/// PostgreSQL: apply EF migrations. SQLite: EnsureCreated for embedded installs.
/// </summary>
static void ApplyDatabaseSchema(WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<DevPilotDbContext>();
    var provider = DatabaseProviderExtensions.GetDatabaseProvider(app.Configuration);
    if (provider == DatabaseProvider.Sqlite)
        db.Database.EnsureCreated();
    else
        db.Database.Migrate();
}

// ---------------------------------------------------------------------------
// HTTP pipeline
// ---------------------------------------------------------------------------

static void ConfigureHttpPipeline(WebApplication app)
{
    if (app.Environment.IsDevelopment())
        app.MapOpenApi();

    MapHealthEndpoints(app);

    app.UseHttpsRedirection();
    app.UseCors();
    app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(25) });
    app.UseAuthentication();
    app.UseAuthorization();

    app.MapControllers();
    app.MapHub<BoardHub>("/hubs/board");
}

/// <summary>
/// No auth; JSON for scripts and load balancers (see infra/local setup).
/// </summary>
static void MapHealthEndpoints(WebApplication app)
{
    app.MapGet("/health", () => Results.Json(new { status = "ok" }));
    app.MapGet("/api/health", () => Results.Json(new { status = "ok" }));
}
