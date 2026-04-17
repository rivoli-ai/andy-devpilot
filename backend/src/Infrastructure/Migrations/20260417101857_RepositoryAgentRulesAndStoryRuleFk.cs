using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace DevPilot.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class RepositoryAgentRulesAndStoryRuleFk : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "repository_agent_rule_id",
                table: "user_stories",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "repository_agent_rules",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    repository_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    body = table.Column<string>(type: "text", nullable: false),
                    is_default = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    sort_order = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_repository_agent_rules", x => x.id);
                    table.ForeignKey(
                        name: "FK_repository_agent_rules_repositories_repository_id",
                        column: x => x.repository_id,
                        principalTable: "repositories",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_user_stories_repository_agent_rule_id",
                table: "user_stories",
                column: "repository_agent_rule_id");

            migrationBuilder.CreateIndex(
                name: "IX_repository_agent_rules_repository_id",
                table: "repository_agent_rules",
                column: "repository_id");

            migrationBuilder.AddForeignKey(
                name: "FK_user_stories_repository_agent_rules_repository_agent_rule_id",
                table: "user_stories",
                column: "repository_agent_rule_id",
                principalTable: "repository_agent_rules",
                principalColumn: "id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_user_stories_repository_agent_rules_repository_agent_rule_id",
                table: "user_stories");

            migrationBuilder.DropTable(
                name: "repository_agent_rules");

            migrationBuilder.DropIndex(
                name: "IX_user_stories_repository_agent_rule_id",
                table: "user_stories");

            migrationBuilder.DropColumn(
                name: "repository_agent_rule_id",
                table: "user_stories");
        }
    }
}
