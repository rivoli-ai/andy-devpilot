namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// EF Core DbContext for DevPilot - PostgreSQL persistence
/// </summary>
public class DevPilotDbContext : DbContext
{
    public DevPilotDbContext(DbContextOptions<DevPilotDbContext> options)
        : base(options)
    {
    }

    public DbSet<User> Users => Set<User>();
    public DbSet<Repository> Repositories => Set<Repository>();
    public DbSet<Epic> Epics => Set<Epic>();
    public DbSet<Feature> Features => Set<Feature>();
    public DbSet<UserStory> UserStories => Set<UserStory>();
    public DbSet<Task> Tasks => Set<Task>();
    public DbSet<LinkedProvider> LinkedProviders => Set<LinkedProvider>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // Entity base - table per type
        modelBuilder.Entity<User>(entity =>
        {
            entity.ToTable("users");
            entity.Ignore(u => u.Repositories); // Avoid duplicate FK - we configure from Repository side
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.Email).HasColumnName("email").HasMaxLength(256);
            entity.Property(e => e.Name).HasColumnName("name").HasMaxLength(256);
            entity.Property(e => e.PasswordHash).HasColumnName("password_hash");
            entity.Property(e => e.EmailVerified).HasColumnName("email_verified").HasDefaultValue(false);
            // Legacy GitHub/AzureDevOps fields - kept for backward compatibility
            entity.Property(e => e.GitHubUsername).HasColumnName("github_username").HasMaxLength(256);
            entity.Property(e => e.GitHubAccessToken).HasColumnName("github_access_token");
            entity.Property(e => e.GitHubTokenExpiresAt).HasColumnName("github_token_expires_at");
            entity.Property(e => e.AzureDevOpsAccessToken).HasColumnName("azure_devops_access_token");
            entity.Property(e => e.AzureDevOpsTokenExpiresAt).HasColumnName("azure_devops_token_expires_at");
            entity.Property(e => e.AzureDevOpsOrganization).HasColumnName("azure_devops_organization").HasMaxLength(256);
            // AI Configuration
            entity.Property(e => e.AiProvider).HasColumnName("ai_provider").HasMaxLength(64);
            entity.Property(e => e.AiApiKey).HasColumnName("ai_api_key");
            entity.Property(e => e.AiModel).HasColumnName("ai_model").HasMaxLength(128);
            entity.Property(e => e.AiBaseUrl).HasColumnName("ai_base_url").HasMaxLength(512);
            entity.HasIndex(e => e.Email).IsUnique();
            entity.HasMany(u => u.LinkedProviders).WithOne(lp => lp.User).HasForeignKey(lp => lp.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<LinkedProvider>(entity =>
        {
            entity.ToTable("linked_providers");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.UserId).HasColumnName("user_id");
            entity.Property(e => e.Provider).HasColumnName("provider").HasMaxLength(64).IsRequired();
            entity.Property(e => e.ProviderUserId).HasColumnName("provider_user_id").HasMaxLength(256).IsRequired();
            entity.Property(e => e.ProviderUsername).HasColumnName("provider_username").HasMaxLength(256);
            entity.Property(e => e.AccessToken).HasColumnName("access_token").IsRequired();
            entity.Property(e => e.RefreshToken).HasColumnName("refresh_token");
            entity.Property(e => e.TokenExpiresAt).HasColumnName("token_expires_at");
            // Unique constraint: one provider per user
            entity.HasIndex(e => new { e.UserId, e.Provider }).IsUnique();
            // Index for looking up by provider and provider user ID
            entity.HasIndex(e => new { e.Provider, e.ProviderUserId });
        });

        modelBuilder.Entity<Repository>(entity =>
        {
            entity.ToTable("repositories");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.Name).HasColumnName("name").HasMaxLength(256);
            entity.Property(e => e.FullName).HasColumnName("full_name").HasMaxLength(512);
            entity.Property(e => e.CloneUrl).HasColumnName("clone_url").HasMaxLength(1024);
            entity.Property(e => e.Description).HasColumnName("description");
            entity.Property(e => e.IsPrivate).HasColumnName("is_private");
            entity.Property(e => e.Provider).HasColumnName("provider").HasMaxLength(64);
            entity.Property(e => e.OrganizationName).HasColumnName("organization_name").HasMaxLength(256);
            entity.Property(e => e.UserId).HasColumnName("user_id");
            entity.Property(e => e.DefaultBranch).HasColumnName("default_branch").HasMaxLength(128);
            entity.HasOne<User>().WithMany().HasForeignKey(e => e.UserId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<Epic>(entity =>
        {
            entity.ToTable("epics");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.Title).HasColumnName("title").HasMaxLength(512);
            entity.Property(e => e.Description).HasColumnName("description");
            entity.Property(e => e.RepositoryId).HasColumnName("repository_id");
            entity.Property(e => e.Status).HasColumnName("status").HasMaxLength(64);
            entity.HasOne(e => e.Repository).WithMany(r => r.Epics).HasForeignKey(e => e.RepositoryId).OnDelete(DeleteBehavior.Cascade);
            entity.HasMany(e => e.Features).WithOne(f => f.Epic).HasForeignKey(f => f.EpicId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<Feature>(entity =>
        {
            entity.ToTable("features");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.Title).HasColumnName("title").HasMaxLength(512);
            entity.Property(e => e.Description).HasColumnName("description");
            entity.Property(e => e.EpicId).HasColumnName("epic_id");
            entity.Property(e => e.Status).HasColumnName("status").HasMaxLength(64);
            entity.HasOne(e => e.Epic).WithMany(ep => ep.Features).HasForeignKey(e => e.EpicId).OnDelete(DeleteBehavior.Cascade);
            entity.HasMany(e => e.UserStories).WithOne(us => us.Feature).HasForeignKey(us => us.FeatureId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<UserStory>(entity =>
        {
            entity.ToTable("user_stories");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.Title).HasColumnName("title").HasMaxLength(512);
            entity.Property(e => e.Description).HasColumnName("description");
            entity.Property(e => e.FeatureId).HasColumnName("feature_id");
            entity.Property(e => e.Status).HasColumnName("status").HasMaxLength(64);
            entity.Property(e => e.AcceptanceCriteria).HasColumnName("acceptance_criteria");
            entity.HasOne(e => e.Feature).WithMany(f => f.UserStories).HasForeignKey(e => e.FeatureId).OnDelete(DeleteBehavior.Cascade);
            entity.HasMany(e => e.Tasks).WithOne(t => t.UserStory).HasForeignKey(t => t.UserStoryId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<Task>(entity =>
        {
            entity.ToTable("tasks");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.Title).HasColumnName("title").HasMaxLength(512);
            entity.Property(e => e.Description).HasColumnName("description");
            entity.Property(e => e.UserStoryId).HasColumnName("user_story_id");
            entity.Property(e => e.Status).HasColumnName("status").HasMaxLength(64);
            entity.Property(e => e.Complexity).HasColumnName("complexity").HasMaxLength(64);
            entity.Property(e => e.AssignedTo).HasColumnName("assigned_to").HasMaxLength(256);
            entity.HasOne(e => e.UserStory).WithMany(us => us.Tasks).HasForeignKey(e => e.UserStoryId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
