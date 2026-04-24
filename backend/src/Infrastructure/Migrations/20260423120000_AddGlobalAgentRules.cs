using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace DevPilot.Infrastructure.Migrations;

/// <inheritdoc />
public partial class AddGlobalAgentRules : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "global_agent_rules",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                name = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                body = table.Column<string>(type: "text", nullable: false),
                sort_order = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_global_agent_rules", x => x.id);
            });
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "global_agent_rules");
    }
}
