namespace DevPilot.Domain.Entities;

/// <summary>
/// MCP (Model Context Protocol) server configuration.
/// When <see cref="UserId"/> is null the record is a shared/global config created by a super-admin
/// and visible to all users. When <see cref="UserId"/> has a value the record is personal to that user.
/// Supports two server types: "stdio" (local command) and "remote" (HTTP URL).
/// </summary>
public class McpServerConfig : Entity
{
    /// <summary>null for shared/global servers; user's id for personal servers.</summary>
    public Guid? UserId { get; private set; }
    public string Name { get; private set; }
    /// <summary>"stdio" or "remote"</summary>
    public string ServerType { get; private set; }

    // stdio fields
    public string? Command { get; private set; }
    /// <summary>JSON array of arguments, e.g. ["-y", "@modelcontextprotocol/server-github"]</summary>
    public string? Args { get; private set; }
    /// <summary>JSON object of environment variables (may contain secrets).</summary>
    public string? EnvJson { get; private set; }

    // remote fields
    public string? Url { get; private set; }
    /// <summary>JSON object of HTTP headers, e.g. {"Authorization": "Bearer ..."}.</summary>
    public string? HeadersJson { get; private set; }

    public bool IsEnabled { get; private set; }

    /// <summary>True when this is a shared/admin-created server (UserId == null).</summary>
    public bool IsShared => UserId == null;

    private McpServerConfig() { }

    /// <summary>Create a personal MCP server config owned by a specific user.</summary>
    public McpServerConfig(
        Guid userId,
        string name,
        string serverType,
        string? command,
        string? args,
        string? envJson,
        string? url,
        string? headersJson,
        bool isEnabled = true)
    {
        UserId = userId;
        Name = name ?? throw new ArgumentNullException(nameof(name));
        ServerType = ValidateServerType(serverType);
        Command = command;
        Args = args;
        EnvJson = envJson;
        Url = url;
        HeadersJson = headersJson;
        IsEnabled = isEnabled;
    }

    /// <summary>Create a shared/global MCP server config (no owner — visible to all users).</summary>
    public static McpServerConfig CreateShared(
        string name,
        string serverType,
        string? command,
        string? args,
        string? envJson,
        string? url,
        string? headersJson)
        => new()
        {
            UserId = null,
            Name = name ?? throw new ArgumentNullException(nameof(name)),
            ServerType = ValidateServerType(serverType),
            Command = command,
            Args = args,
            EnvJson = envJson,
            Url = url,
            HeadersJson = headersJson,
            IsEnabled = true,
        };

    public void Update(
        string? name,
        string? serverType,
        string? command,
        string? args,
        string? envJson,
        string? url,
        string? headersJson)
    {
        if (name != null) Name = name;
        if (serverType != null) ServerType = ValidateServerType(serverType);
        if (command != null) Command = command;
        if (args != null) Args = args;
        if (envJson != null) EnvJson = envJson;
        if (url != null) Url = url;
        if (headersJson != null) HeadersJson = headersJson;
        MarkAsUpdated();
    }

    public void SetEnabled(bool enabled)
    {
        IsEnabled = enabled;
        MarkAsUpdated();
    }

    private static string ValidateServerType(string serverType)
    {
        if (serverType is not ("stdio" or "remote"))
            throw new ArgumentException("ServerType must be 'stdio' or 'remote'.", nameof(serverType));
        return serverType;
    }
}
