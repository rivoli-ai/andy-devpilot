using System.Text;
using DevPilot.API.Hubs;
using DevPilot.Application.Services;
using DevPilot.Infrastructure.Persistence;
using DevPilot.Infrastructure.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddControllers();
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();

// Add SignalR for real-time communication
builder.Services.AddSignalR();

// Configure JWT Authentication
var secretKey = builder.Configuration["JWT:SecretKey"] ?? "dev-secret-key-min-32-characters-long-for-security";
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

builder.Services.AddAuthorization();

// Register Application layer services (MediatR, handlers, etc.)
builder.Services.AddApplication();

// Register Infrastructure layer services (repositories, external services, etc.)
builder.Services.AddInfrastructure(builder.Configuration);

var app = builder.Build();

// Apply pending migrations on startup (ensures DB schema is up to date)
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<DevPilotDbContext>();
    db.Database.EnsureCreated();
    db.Database.Migrate();
}

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();

// Configure CORS for SignalR and frontend
app.UseCors(policy => policy
    .WithOrigins("http://localhost:4200") // Angular dev server
    .AllowAnyMethod()
    .AllowAnyHeader()
    .AllowCredentials());

// Authentication must come before Authorization
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

// Map SignalR hubs
app.MapHub<BoardHub>("/hubs/board");

app.Run();
