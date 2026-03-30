using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace DevPilot.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddRepositoryAzureIdentity : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "azure_identity_client_id",
                table: "repositories",
                type: "character varying(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "azure_identity_client_secret",
                table: "repositories",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "azure_identity_tenant_id",
                table: "repositories",
                type: "character varying(256)",
                maxLength: 256,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "azure_identity_client_id",
                table: "repositories");

            migrationBuilder.DropColumn(
                name: "azure_identity_client_secret",
                table: "repositories");

            migrationBuilder.DropColumn(
                name: "azure_identity_tenant_id",
                table: "repositories");
        }
    }
}
