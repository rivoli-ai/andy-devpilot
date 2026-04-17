using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace DevPilot.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddStorySandboxConversationSnapshots : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "story_sandbox_conversation_snapshots",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_story_id = table.Column<Guid>(type: "uuid", nullable: false),
                    sandbox_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    payload_json = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_story_sandbox_conversation_snapshots", x => x.id);
                    table.ForeignKey(
                        name: "FK_story_sandbox_conversation_snapshots_user_stories_user_stor~",
                        column: x => x.user_story_id,
                        principalTable: "user_stories",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_story_sandbox_conversation_snapshots_user_story_id_sandbox_~",
                table: "story_sandbox_conversation_snapshots",
                columns: new[] { "user_story_id", "sandbox_id" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "story_sandbox_conversation_snapshots");
        }
    }
}
