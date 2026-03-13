using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace DevPilot.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class SharedLlmProviders : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // 1. Make llm_settings.user_id nullable so shared (admin) providers have no owner.
            migrationBuilder.AlterColumn<Guid>(
                name: "user_id",
                table: "llm_settings",
                type: "uuid",
                nullable: true,
                oldClrType: typeof(Guid),
                oldType: "uuid");

            // Drop the old NOT-NULL FK constraint and recreate as nullable.
            migrationBuilder.DropForeignKey(
                name: "fk_llm_settings_users_user_id",
                table: "llm_settings");

            migrationBuilder.AddForeignKey(
                name: "fk_llm_settings_users_user_id",
                table: "llm_settings",
                column: "user_id",
                principalTable: "users",
                principalColumn: "id",
                onDelete: ReferentialAction.Cascade);

            // 2. Add preferred_shared_llm_setting_id to users table.
            migrationBuilder.AddColumn<Guid>(
                name: "preferred_shared_llm_setting_id",
                table: "users",
                type: "uuid",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "preferred_shared_llm_setting_id",
                table: "users");

            migrationBuilder.DropForeignKey(
                name: "fk_llm_settings_users_user_id",
                table: "llm_settings");

            migrationBuilder.AlterColumn<Guid>(
                name: "user_id",
                table: "llm_settings",
                type: "uuid",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"),
                oldClrType: typeof(Guid),
                oldType: "uuid",
                oldNullable: true);

            migrationBuilder.AddForeignKey(
                name: "fk_llm_settings_users_user_id",
                table: "llm_settings",
                column: "user_id",
                principalTable: "users",
                principalColumn: "id",
                onDelete: ReferentialAction.Cascade);
        }
    }
}
