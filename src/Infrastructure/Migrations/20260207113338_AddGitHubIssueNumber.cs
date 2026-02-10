using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace DevPilot.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddGitHubIssueNumber : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "github_issue_number",
                table: "user_stories",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "github_issue_number",
                table: "features",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "github_issue_number",
                table: "user_stories");

            migrationBuilder.DropColumn(
                name: "github_issue_number",
                table: "features");
        }
    }
}
