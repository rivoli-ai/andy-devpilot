namespace DevPilot.Application.Constants;

/// <summary>Fallback agent instructions when a repository has no custom rules.</summary>
public static class DefaultAgentRules
{
    public const string Markdown =
        "# DevPilot AI Agent Instructions\n\n" +
        "## Before Making Changes\n" +
        "1. Explore the project structure and identify the tech stack\n" +
        "2. Read README.md if it exists\n" +
        "3. Find and run the existing build command (e.g. dotnet build, npm run build, mvn compile, go build)\n" +
        "4. Find and run existing tests (e.g. dotnet test, npm test, pytest, go test)\n" +
        "5. Note any failing tests or build errors before your changes\n\n" +
        "## After Making Changes\n" +
        "1. Build the project again and fix any compilation errors\n" +
        "2. Run all tests and fix any regressions you introduced\n" +
        "3. Explain what you changed and why\n\n" +
        "## Guidelines\n" +
        "- Follow the existing code style and conventions\n" +
        "- Prioritize security and performance\n" +
        "- Be concise and actionable in your suggestions\n" +
        "- Explain your reasoning when making suggestions";
}
