using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace DevPilot.Infrastructure.Migrations;

/// <summary>
/// Idempotent repair if the database still has the legacy unique index on (user_id, repository_id)
/// only — e.g. history out of sync or a failed apply. Safe to run when the index is already correct.
/// </summary>
[Migration("20260427120000_RepairUserRepositorySandboxPerBranchIndexIfNeeded")]
public class RepairUserRepositorySandboxPerBranchIndexIfNeeded : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
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
        // No-op: reversing this repair could fail if multiple branch rows exist.
    }
}
