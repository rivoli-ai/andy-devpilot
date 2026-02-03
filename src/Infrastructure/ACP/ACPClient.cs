namespace DevPilot.Infrastructure.ACP;

using DevPilot.Application.Services;
using System;
using Microsoft.Extensions.Logging;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

/// <summary>
/// ACP client implementation using WebSocket for communication with Zed containers
/// Handles ACP protocol messages (JSON-over-WebSocket)
/// </summary>
public class ACPClient : IACPClient
{
    private readonly ILogger<ACPClient> _logger;
    private ClientWebSocket? _webSocket;
    private string? _sessionId;
    private bool _disposed;

    public ACPClient(ILogger<ACPClient> logger)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public bool IsConnected => _webSocket?.State == WebSocketState.Open;

    public event EventHandler<ACPLogEventArgs>? LogReceived;

    public async System.Threading.Tasks.Task ConnectAsync(
        string sessionId,
        string endpointUrl,
        string authToken,
        CancellationToken cancellationToken = default)
    {
        try
        {
            _sessionId = sessionId;

            // Convert HTTP endpoint to WebSocket URL
            var wsUrl = endpointUrl.Replace("http://", "ws://").Replace("https://", "wss://");
            if (!wsUrl.EndsWith("/ws"))
            {
                wsUrl = $"{wsUrl.TrimEnd('/')}/ws";
            }

            _webSocket = new ClientWebSocket();
            
            // Add authentication header
            _webSocket.Options.SetRequestHeader("Authorization", $"Bearer {authToken}");
            _webSocket.Options.SetRequestHeader("X-Session-Id", sessionId);

            _logger.LogInformation("Connecting to ACP endpoint {Endpoint} for session {SessionId}", wsUrl, sessionId);

            var uri = new Uri(wsUrl);
            await _webSocket.ConnectAsync(uri, cancellationToken);

            _logger.LogInformation("Successfully connected to ACP endpoint for session {SessionId}", sessionId);

            // Start listening for messages in background
            _ = Task.Run(() => ListenForMessages(cancellationToken), cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to connect to ACP endpoint for session {SessionId}", sessionId);
            throw;
        }
    }

    public async System.Threading.Tasks.Task DisconnectAsync(CancellationToken cancellationToken = default)
    {
        if (_webSocket?.State == WebSocketState.Open)
        {
            try
            {
                await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Client disconnecting", cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Error during WebSocket close");
            }
        }

        _webSocket?.Dispose();
        _webSocket = null;
    }

    public async System.Threading.Tasks.Task<ACPResponse> InitSessionAsync(
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        return await SendACPCommandAsync("INIT_SESSION", new { sessionId }, cancellationToken);
    }

    public async System.Threading.Tasks.Task<ACPResponse> CloneRepositoryAsync(
        string cloneUrl,
        string? branch = null,
        CancellationToken cancellationToken = default)
    {
        return await SendACPCommandAsync("CLONE_REPOSITORY", new { cloneUrl, branch }, cancellationToken);
    }

    public async System.Threading.Tasks.Task<ACPResponse> RunCommandAsync(
        string command,
        string? workingDirectory = null,
        CancellationToken cancellationToken = default)
    {
        return await SendACPCommandAsync("RUN_COMMAND", new { command, workingDirectory }, cancellationToken);
    }

    public async System.Threading.Tasks.Task<RepositoryAnalysisResult> AnalyzeRepositoryAsync(
        string repositoryName,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Starting repository analysis for {RepositoryName} via ACP", repositoryName);

        // Step 1: Generate repository content summary
        var summaryCommand = "find . -type f -name '*.cs' -o -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.md' | head -100 | xargs cat | head -50000";
        var summaryResponse = await RunCommandAsync(summaryCommand, cancellationToken: cancellationToken);

        if (!summaryResponse.Success)
        {
            throw new InvalidOperationException($"Failed to generate repository summary: {summaryResponse.Error}");
        }

        var repositoryContent = summaryResponse.Data ?? "";

        // Step 2: Run AI analysis command
        // This command should be available in the Zed container and use the AI service
        var analysisCommand = $@"
cat > /tmp/analyze.sh << 'EOF'
#!/bin/bash
# Repository analysis script
# This would call the AI analysis service with repository content
echo '{{
  ""reasoning"": ""Analyzed repository structure and code patterns"",
  ""epics"": [],
  ""metadata"": {{
    ""analysisTimestamp"": ""{DateTime.UtcNow:O}"",
    ""model"": ""vps-analysis"",
    ""reasoning"": ""Analysis via VPS/Zed container""
  }}
}}'
EOF
chmod +x /tmp/analyze.sh
/tmp/analyze.sh
";

        var analysisResponse = await RunCommandAsync(analysisCommand, cancellationToken: cancellationToken);

        if (!analysisResponse.Success)
        {
            throw new InvalidOperationException($"Failed to analyze repository: {analysisResponse.Error}");
        }

        // Parse JSON response
        var options = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        };

        var result = JsonSerializer.Deserialize<RepositoryAnalysisResult>(analysisResponse.Data ?? "{}", options);

        if (result == null)
        {
            throw new InvalidOperationException("Failed to parse analysis result from ACP response");
        }

        _logger.LogInformation("Successfully analyzed repository {RepositoryName} via ACP. Generated {EpicCount} epics", 
            repositoryName, result.Epics.Count);

        return result;
    }

    public async System.Threading.Tasks.Task<ACPResponse> CloseSessionAsync(CancellationToken cancellationToken = default)
    {
        var response = await SendACPCommandAsync("CLOSE_SESSION", new { }, cancellationToken);
        await DisconnectAsync(cancellationToken);
        return response;
    }

    private async System.Threading.Tasks.Task<ACPResponse> SendACPCommandAsync(
        string command,
        object payload,
        CancellationToken cancellationToken)
    {
        if (!IsConnected || _webSocket == null)
        {
            throw new InvalidOperationException("ACP client is not connected");
        }

        var correlationId = Guid.NewGuid().ToString();
        var message = new ACPMessage
        {
            SessionId = _sessionId ?? "",
            Command = command,
            Payload = payload,
            CorrelationId = correlationId
        };

        var json = JsonSerializer.Serialize(message);
        var bytes = Encoding.UTF8.GetBytes(json);

        _logger.LogDebug("Sending ACP command {Command} with correlation {CorrelationId}", command, correlationId);

        await _webSocket.SendAsync(
            new ArraySegment<byte>(bytes),
            WebSocketMessageType.Text,
            endOfMessage: true,
            cancellationToken);

        // Wait for response (this is a simplified version - in production, use a response queue)
        // For now, we'll wait a short time and expect immediate response
        await System.Threading.Tasks.Task.Delay(100, cancellationToken);

        // TODO: Implement proper response handling with correlation ID matching
        // For now, return a placeholder response
        return new ACPResponse
        {
            CorrelationId = correlationId,
            Success = true,
            Command = command,
            Data = "{}"
        };
    }

    private async System.Threading.Tasks.Task ListenForMessages(CancellationToken cancellationToken)
    {
        if (_webSocket == null) return;

        var buffer = new byte[1024 * 4];

        try
        {
            while (_webSocket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
            {
                var result = await _webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Server closed connection", cancellationToken);
                    break;
                }

                if (result.MessageType == WebSocketMessageType.Text)
                {
                    var message = Encoding.UTF8.GetString(buffer, 0, result.Count);
                    ProcessMessage(message);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ACP message listener for session {SessionId}", _sessionId);
        }
    }

    private void ProcessMessage(string messageJson)
    {
        try
        {
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var message = JsonSerializer.Deserialize<ACPMessage>(messageJson, options);

            if (message == null) return;

            // Handle log messages
            if (message.Command == "LOG" && message.Payload is JsonElement logElement)
            {
                var logLevel = logElement.GetProperty("level").GetString() ?? "info";
                var logMessage = logElement.GetProperty("message").GetString() ?? "";

                LogReceived?.Invoke(this, new ACPLogEventArgs
                {
                    SessionId = _sessionId ?? "",
                    LogLevel = logLevel,
                    Message = logMessage,
                    Timestamp = DateTime.UtcNow
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to process ACP message: {Message}", messageJson);
        }
    }

    /// <summary>
    /// ACP protocol message structure
    /// </summary>
    private class ACPMessage
    {
        public string SessionId { get; set; } = string.Empty;
        public string Command { get; set; } = string.Empty;
        public object? Payload { get; set; }
        public string CorrelationId { get; set; } = string.Empty;
    }

    protected virtual void Dispose(bool disposing)
    {
        if (!_disposed && disposing)
        {
            DisconnectAsync().GetAwaiter().GetResult();
            _disposed = true;
        }
    }

    public void Dispose()
    {
        Dispose(disposing: true);
        GC.SuppressFinalize(this);
    }
}
