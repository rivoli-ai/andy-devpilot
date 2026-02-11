using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace DevPilot.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddCodeAnalysisEntities : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "code_analyses",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    repository_id = table.Column<Guid>(type: "uuid", nullable: false),
                    branch = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    summary = table.Column<string>(type: "text", nullable: false),
                    architecture = table.Column<string>(type: "text", nullable: true),
                    key_components = table.Column<string>(type: "text", nullable: true),
                    dependencies = table.Column<string>(type: "text", nullable: true),
                    recommendations = table.Column<string>(type: "text", nullable: true),
                    analyzed_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    model = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_code_analyses", x => x.id);
                    table.ForeignKey(
                        name: "FK_code_analyses_repositories_repository_id",
                        column: x => x.repository_id,
                        principalTable: "repositories",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "file_analyses",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    repository_id = table.Column<Guid>(type: "uuid", nullable: false),
                    file_path = table.Column<string>(type: "character varying(1024)", maxLength: 1024, nullable: false),
                    branch = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    explanation = table.Column<string>(type: "text", nullable: false),
                    key_functions = table.Column<string>(type: "text", nullable: true),
                    complexity = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    suggestions = table.Column<string>(type: "text", nullable: true),
                    analyzed_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    model = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_file_analyses", x => x.id);
                    table.ForeignKey(
                        name: "FK_file_analyses_repositories_repository_id",
                        column: x => x.repository_id,
                        principalTable: "repositories",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_code_analyses_repository_id_branch",
                table: "code_analyses",
                columns: new[] { "repository_id", "branch" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_file_analyses_repository_id_file_path_branch",
                table: "file_analyses",
                columns: new[] { "repository_id", "file_path", "branch" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "code_analyses");

            migrationBuilder.DropTable(
                name: "file_analyses");
        }
    }
}
