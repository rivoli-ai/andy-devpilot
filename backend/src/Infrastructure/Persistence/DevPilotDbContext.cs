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
    public DbSet<RepositoryAgentRule> RepositoryAgentRules => Set<RepositoryAgentRule>();
    public DbSet<GlobalAgentRule> GlobalAgentRules => Set<GlobalAgentRule>();
    public DbSet<Task> Tasks => Set<Task>();
    public DbSet<LinkedProvider> LinkedProviders => Set<LinkedProvider>();
    public DbSet<CodeAnalysis> CodeAnalyses => Set<CodeAnalysis>();
    public DbSet<FileAnalysis> FileAnalyses => Set<FileAnalysis>();
    public DbSet<RepositoryShare> RepositoryShares => Set<RepositoryShare>();
    public DbSet<LlmSetting> LlmSettings => Set<LlmSetting>();
    public DbSet<McpServerConfig> McpServerConfigs => Set<McpServerConfig>();
    public DbSet<ArtifactFeedConfig> ArtifactFeedConfigs => Set<ArtifactFeedConfig>();
    public DbSet<StorySandboxConversationSnapshot> StorySandboxConversationSnapshots => Set<StorySandboxConversationSnapshot>();
    public DbSet<UserRepositorySandboxBinding> UserRepositorySandboxBindings => Set<UserRepositorySandboxBinding>();
    public DbSet<CodeAskConversationSnapshot> CodeAskConversationSnapshots => Set<CodeAskConversationSnapshot>();

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
            entity.Property(e => e.PreferredSharedLlmSettingId).HasColumnName("preferred_shared_llm_setting_id");
            entity.Property(e => e.IsAdmin).HasColumnName("is_admin").HasDefaultValue(false);
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
            entity.Property(e => e.LlmSettingId).HasColumnName("llm_setting_id");
            entity.Property(e => e.AgentRules).HasColumnName("agent_rules");
            entity.Property(e => e.AzureIdentityClientId).HasColumnName("azure_identity_client_id").HasMaxLength(256);
            entity.Property(e => e.AzureIdentityClientSecret).HasColumnName("azure_identity_client_secret");
            entity.Property(e => e.AzureIdentityTenantId).HasColumnName("azure_identity_tenant_id").HasMaxLength(256);
            entity.HasOne<User>().WithMany().HasForeignKey(e => e.UserId).OnDelete(DeleteBehavior.Restrict);
            entity.HasMany(e => e.RepositoryAgentRules)
                .WithOne(ar => ar.Repository)
                .HasForeignKey(ar => ar.RepositoryId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<RepositoryAgentRule>(entity =>
        {
            entity.ToTable("repository_agent_rules");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.RepositoryId).HasColumnName("repository_id");
            entity.Property(e => e.Name).HasColumnName("name").HasMaxLength(128);
            entity.Property(e => e.Body).HasColumnName("body");
            entity.Property(e => e.IsDefault).HasColumnName("is_default").HasDefaultValue(false);
            entity.Property(e => e.SortOrder).HasColumnName("sort_order").HasDefaultValue(0);
            entity.HasIndex(e => e.RepositoryId);
        });

        modelBuilder.Entity<GlobalAgentRule>(entity =>
        {
            entity.ToTable("global_agent_rules");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.Name).HasColumnName("name").HasMaxLength(128);
            entity.Property(e => e.Body).HasColumnName("body");
            entity.Property(e => e.SortOrder).HasColumnName("sort_order").HasDefaultValue(0);
        });

        modelBuilder.Entity<LlmSetting>(entity =>
        {
            entity.ToTable("llm_settings");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.UserId).HasColumnName("user_id").IsRequired(false);
            entity.Property(e => e.Name).HasColumnName("name").HasMaxLength(128).IsRequired();
            entity.Property(e => e.Provider).HasColumnName("provider").HasMaxLength(64).IsRequired();
            entity.Property(e => e.ApiKey).HasColumnName("api_key");
            entity.Property(e => e.Model).HasColumnName("model").HasMaxLength(128).IsRequired();
            entity.Property(e => e.BaseUrl).HasColumnName("base_url").HasMaxLength(512);
            entity.Property(e => e.IsDefault).HasColumnName("is_default").HasDefaultValue(false);
            // Shared providers (UserId = null) have no FK; personal ones cascade-delete with the user.
            entity.HasOne<User>().WithMany().HasForeignKey(e => e.UserId).IsRequired(false).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<McpServerConfig>(entity =>
        {
            entity.ToTable("mcp_server_configs");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.UserId).HasColumnName("user_id").IsRequired(false);
            entity.Property(e => e.Name).HasColumnName("name").HasMaxLength(256).IsRequired();
            entity.Property(e => e.ServerType).HasColumnName("server_type").HasMaxLength(16).IsRequired();
            entity.Property(e => e.Command).HasColumnName("command").HasMaxLength(512);
            entity.Property(e => e.Args).HasColumnName("args");
            entity.Property(e => e.EnvJson).HasColumnName("env_json");
            entity.Property(e => e.Url).HasColumnName("url").HasMaxLength(2048);
            entity.Property(e => e.HeadersJson).HasColumnName("headers_json");
            entity.Property(e => e.IsEnabled).HasColumnName("is_enabled").HasDefaultValue(true);
            entity.HasOne<User>().WithMany().HasForeignKey(e => e.UserId).IsRequired(false).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<ArtifactFeedConfig>(entity =>
        {
            entity.ToTable("artifact_feed_configs");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.Name).HasColumnName("name").HasMaxLength(256).IsRequired();
            entity.Property(e => e.Organization).HasColumnName("organization").HasMaxLength(256).IsRequired();
            entity.Property(e => e.FeedName).HasColumnName("feed_name").HasMaxLength(256).IsRequired();
            entity.Property(e => e.ProjectName).HasColumnName("project_name").HasMaxLength(256);
            entity.Property(e => e.FeedType).HasColumnName("feed_type").HasMaxLength(16).IsRequired();
            entity.Property(e => e.IsEnabled).HasColumnName("is_enabled").HasDefaultValue(true);
            entity.Property(e => e.OwnerUserId).HasColumnName("owner_user_id");
            entity.HasOne<User>().WithMany().HasForeignKey(e => e.OwnerUserId).IsRequired(false).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<RepositoryShare>(entity =>
        {
            entity.ToTable("repository_shares");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.RepositoryId).HasColumnName("repository_id");
            entity.Property(e => e.SharedWithUserId).HasColumnName("shared_with_user_id");
            entity.HasOne<Repository>().WithMany().HasForeignKey(e => e.RepositoryId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<User>().WithMany().HasForeignKey(e => e.SharedWithUserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(e => new { e.RepositoryId, e.SharedWithUserId }).IsUnique();
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
            entity.Property(e => e.Source).HasColumnName("source").HasMaxLength(32).HasDefaultValue("Manual");
            entity.Property(e => e.AzureDevOpsWorkItemId).HasColumnName("azure_devops_work_item_id");
            entity.Property(e => e.GitHubIssueNumber).HasColumnName("github_issue_number");
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
            entity.Property(e => e.Source).HasColumnName("source").HasMaxLength(32).HasDefaultValue("Manual");
            entity.Property(e => e.AzureDevOpsWorkItemId).HasColumnName("azure_devops_work_item_id");
            entity.Property(e => e.GitHubIssueNumber).HasColumnName("github_issue_number");
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
            entity.Property(e => e.Source).HasColumnName("source").HasMaxLength(32).HasDefaultValue("Manual");
            entity.Property(e => e.AzureDevOpsWorkItemId).HasColumnName("azure_devops_work_item_id");
            entity.Property(e => e.GitHubIssueNumber).HasColumnName("github_issue_number");
            entity.Property(e => e.RepositoryAgentRuleId).HasColumnName("repository_agent_rule_id");
            entity.HasOne(e => e.Feature).WithMany(f => f.UserStories).HasForeignKey(e => e.FeatureId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(e => e.RepositoryAgentRule)
                .WithMany()
                .HasForeignKey(e => e.RepositoryAgentRuleId)
                .OnDelete(DeleteBehavior.SetNull);
            entity.HasMany(e => e.Tasks).WithOne(t => t.UserStory).HasForeignKey(t => t.UserStoryId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<StorySandboxConversationSnapshot>(entity =>
        {
            entity.ToTable("story_sandbox_conversation_snapshots");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.UserStoryId).HasColumnName("user_story_id");
            entity.Property(e => e.SandboxId).HasColumnName("sandbox_id").HasMaxLength(64).IsRequired();
            entity.Property(e => e.PayloadJson).HasColumnName("payload_json").IsRequired();
            entity.HasOne<UserStory>().WithMany().HasForeignKey(e => e.UserStoryId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(e => new { e.UserStoryId, e.SandboxId }).IsUnique();
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

        modelBuilder.Entity<CodeAnalysis>(entity =>
        {
            entity.ToTable("code_analyses");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.RepositoryId).HasColumnName("repository_id");
            entity.Property(e => e.Branch).HasColumnName("branch").HasMaxLength(256);
            entity.Property(e => e.Summary).HasColumnName("summary");
            entity.Property(e => e.Architecture).HasColumnName("architecture");
            entity.Property(e => e.KeyComponents).HasColumnName("key_components");
            entity.Property(e => e.Dependencies).HasColumnName("dependencies");
            entity.Property(e => e.Recommendations).HasColumnName("recommendations");
            entity.Property(e => e.AnalyzedAt).HasColumnName("analyzed_at");
            entity.Property(e => e.Model).HasColumnName("model").HasMaxLength(128);
            entity.HasOne(e => e.Repository).WithMany().HasForeignKey(e => e.RepositoryId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(e => new { e.RepositoryId, e.Branch }).IsUnique();
        });

        modelBuilder.Entity<FileAnalysis>(entity =>
        {
            entity.ToTable("file_analyses");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.RepositoryId).HasColumnName("repository_id");
            entity.Property(e => e.FilePath).HasColumnName("file_path").HasMaxLength(1024);
            entity.Property(e => e.Branch).HasColumnName("branch").HasMaxLength(256);
            entity.Property(e => e.Explanation).HasColumnName("explanation");
            entity.Property(e => e.KeyFunctions).HasColumnName("key_functions");
            entity.Property(e => e.Complexity).HasColumnName("complexity");
            entity.Property(e => e.Suggestions).HasColumnName("suggestions");
            entity.Property(e => e.AnalyzedAt).HasColumnName("analyzed_at");
            entity.Property(e => e.Model).HasColumnName("model").HasMaxLength(128);
            entity.HasOne(e => e.Repository).WithMany().HasForeignKey(e => e.RepositoryId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(e => new { e.RepositoryId, e.FilePath, e.Branch }).IsUnique();
        });

        modelBuilder.Entity<CodeAskConversationSnapshot>(entity =>
        {
            entity.ToTable("code_ask_conversation_snapshots");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.UserId).HasColumnName("user_id");
            entity.Property(e => e.RepositoryId).HasColumnName("repository_id");
            entity.Property(e => e.RepoBranchKey).HasColumnName("repo_branch_key").HasMaxLength(256).IsRequired();
            entity.Property(e => e.PayloadJson).HasColumnName("payload_json").IsRequired();
            entity.HasIndex(e => new { e.UserId, e.RepositoryId, e.RepoBranchKey }).IsUnique();
            entity.HasOne<User>().WithMany().HasForeignKey(e => e.UserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<Repository>().WithMany().HasForeignKey(e => e.RepositoryId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<UserRepositorySandboxBinding>(entity =>
        {
            entity.ToTable("user_repository_sandbox_bindings");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.Property(e => e.UpdatedAt).HasColumnName("updated_at");
            entity.Property(e => e.UserId).HasColumnName("user_id");
            entity.Property(e => e.RepositoryId).HasColumnName("repository_id");
            entity.Property(e => e.SandboxId).HasColumnName("sandbox_id").HasMaxLength(64).IsRequired();
            entity.Property(e => e.RepoBranch).HasColumnName("repo_branch").HasMaxLength(256).IsRequired();
            // One active Ask sandbox per (user, repository, branch) so branches do not share a container.
            entity.HasIndex(e => new { e.UserId, e.RepositoryId, e.RepoBranch })
                .IsUnique()
                .HasDatabaseName("IX_ur_sb_binding_user_id_repo_id_branch");
            entity.HasOne<User>().WithMany().HasForeignKey(e => e.UserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<Repository>().WithMany().HasForeignKey(e => e.RepositoryId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
