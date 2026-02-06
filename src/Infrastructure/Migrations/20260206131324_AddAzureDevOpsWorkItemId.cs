using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace DevPilot.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddAzureDevOpsWorkItemId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "azure_devops_work_item_id",
                table: "user_stories",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "azure_devops_work_item_id",
                table: "features",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "azure_devops_work_item_id",
                table: "epics",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "azure_devops_work_item_id",
                table: "user_stories");

            migrationBuilder.DropColumn(
                name: "azure_devops_work_item_id",
                table: "features");

            migrationBuilder.DropColumn(
                name: "azure_devops_work_item_id",
                table: "epics");
        }
    }
}
