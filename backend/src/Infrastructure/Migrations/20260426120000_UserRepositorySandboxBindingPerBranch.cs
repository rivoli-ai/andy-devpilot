using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace DevPilot.Infrastructure.Migrations
{
    /// <inheritdoc />
    [Migration("20260426120000_UserRepositorySandboxBindingPerBranch")]
    public partial class UserRepositorySandboxBindingPerBranch : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Use raw SQL so this is idempotent. DropIndex+CreateIndex can fail if the old index
            // name in PostgreSQL does not match exactly, which leaves the DB on the (user+repo) unique
            // and blocks per-branch sandboxes.
            migrationBuilder.Sql("""
                DROP INDEX IF EXISTS "IX_user_repository_sandbox_bindings_user_id_repository_id";
                """);

            migrationBuilder.Sql("""
                CREATE UNIQUE INDEX IF NOT EXISTS "IX_ur_sb_binding_user_id_repo_id_branch"
                ON user_repository_sandbox_bindings (user_id, repository_id, repo_branch);
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DROP INDEX IF EXISTS "IX_ur_sb_binding_user_id_repo_id_branch";
                """);

            migrationBuilder.CreateIndex(
                name: "IX_user_repository_sandbox_bindings_user_id_repository_id",
                table: "user_repository_sandbox_bindings",
                columns: new[] { "user_id", "repository_id" },
                unique: true);
        }
    }
}
