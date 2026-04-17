using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace DevPilot.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class ArtifactFeedOwnerUser : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "owner_user_id",
                table: "artifact_feed_configs",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_artifact_feed_configs_owner_user_id",
                table: "artifact_feed_configs",
                column: "owner_user_id");

            migrationBuilder.AddForeignKey(
                name: "FK_artifact_feed_configs_users_owner_user_id",
                table: "artifact_feed_configs",
                column: "owner_user_id",
                principalTable: "users",
                principalColumn: "id",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_artifact_feed_configs_users_owner_user_id",
                table: "artifact_feed_configs");

            migrationBuilder.DropIndex(
                name: "IX_artifact_feed_configs_owner_user_id",
                table: "artifact_feed_configs");

            migrationBuilder.DropColumn(
                name: "owner_user_id",
                table: "artifact_feed_configs");
        }
    }
}
