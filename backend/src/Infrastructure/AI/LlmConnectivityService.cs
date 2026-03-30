namespace DevPilot.Infrastructure.AI;

using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using Microsoft.Extensions.Logging;

/// <inheritdoc />
public sealed class LlmConnectivityService : ILlmConnectivityService
{
    /// <summary>Minimal chat call: actually bills auth (unlike some proxies that return 200 on <c>/v1/models</c>).</summary>
    private const string OpenAiOfficialPingModel = "gpt-4o-mini";

    /// <summary>Cheap model id for ping; validates API key without relying on the user’s configured model name.</summary>
    private const string AnthropicPingModel = "claude-3-5-haiku-20241022";

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<LlmConnectivityService> _logger;

    public LlmConnectivityService(IHttpClientFactory httpClientFactory, ILogger<LlmConnectivityService> logger)
    {
        _httpClientFactory = httpClientFactory ?? throw new ArgumentNullException(nameof(httpClientFactory));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <inheritdoc />
    public async Task<LlmConnectivityResult> TestAsync(LlmSetting setting, CancellationToken cancellationToken = default)
    {
        var provider = (setting.Provider ?? string.Empty).Trim().ToLowerInvariant();
        try
        {
            return provider switch
            {
                "openai" => await TestOpenAiAsync(setting, cancellationToken),
                "anthropic" => await TestAnthropicAsync(setting, cancellationToken),
                "ollama" => await TestOllamaAsync(setting, cancellationToken),
                "custom" => await TestOpenAiCompatibleAsync(setting, cancellationToken),
                _ => new LlmConnectivityResult(false, $"Unknown provider: {setting.Provider}")
            };
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "LLM connectivity HTTP error for provider {Provider}", provider);
            return new LlmConnectivityResult(false, ex.Message.Contains("refused", StringComparison.OrdinalIgnoreCase)
                ? "Host unreachable"
                : ex.Message);
        }
        catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException || !cancellationToken.IsCancellationRequested)
        {
            return new LlmConnectivityResult(false, "Request timed out");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "LLM connectivity error for provider {Provider}", provider);
            return new LlmConnectivityResult(false, ex.Message);
        }
    }

    private async Task<LlmConnectivityResult> TestOpenAiAsync(LlmSetting setting, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(setting.ApiKey))
            return new LlmConnectivityResult(false, "No API key configured");

        return await SendOpenAiChatCompletionPingAsync(
            "https://api.openai.com/v1/chat/completions",
            OpenAiOfficialPingModel,
            setting.ApiKey.Trim(),
            ct);
    }

    private async Task<LlmConnectivityResult> TestAnthropicAsync(LlmSetting setting, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(setting.ApiKey))
            return new LlmConnectivityResult(false, "No API key configured");

        var client = _httpClientFactory.CreateClient("LlmConnectivity");
        var bodyObj = new
        {
            model = AnthropicPingModel,
            max_tokens = 1,
            messages = new[] { new { role = "user", content = "." } }
        };
        var json = JsonSerializer.Serialize(bodyObj);
        using var req = new HttpRequestMessage(HttpMethod.Post, "https://api.anthropic.com/v1/messages")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        req.Headers.TryAddWithoutValidation("x-api-key", setting.ApiKey.Trim());
        req.Headers.TryAddWithoutValidation("anthropic-version", "2023-06-01");

        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            var msg = await ReadAnthropicErrorAsync(resp, ct);
            return new LlmConnectivityResult(false, msg ?? $"HTTP {(int)resp.StatusCode}");
        }

        var anthropicBody = await resp.Content.ReadAsStringAsync(ct);
        if (!TryValidateAnthropicMessageBody(anthropicBody, out var anthropicErr))
            return new LlmConnectivityResult(false, anthropicErr);
        return new LlmConnectivityResult(true, null);
    }

    private async Task<LlmConnectivityResult> TestOllamaAsync(LlmSetting setting, CancellationToken ct)
    {
        var baseUrl = string.IsNullOrWhiteSpace(setting.BaseUrl)
            ? "http://localhost:11434"
            : setting.BaseUrl!.Trim().TrimEnd('/');
        var client = _httpClientFactory.CreateClient("LlmConnectivity");
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/api/tags");
        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            var bodyErr = await resp.Content.ReadAsStringAsync(ct);
            return new LlmConnectivityResult(false, string.IsNullOrWhiteSpace(bodyErr)
                ? $"HTTP {(int)resp.StatusCode}"
                : bodyErr.Length > 200 ? bodyErr[..200] + "…" : bodyErr);
        }

        var ollamaBody = await resp.Content.ReadAsStringAsync(ct);
        if (!TryValidateOllamaTagsBody(ollamaBody, out var ollamaErr))
            return new LlmConnectivityResult(false, ollamaErr);
        return new LlmConnectivityResult(true, null);
    }

    private async Task<LlmConnectivityResult> TestOpenAiCompatibleAsync(LlmSetting setting, CancellationToken ct)
    {
        var raw = setting.BaseUrl?.Trim().TrimEnd('/') ?? string.Empty;
        if (string.IsNullOrEmpty(raw))
            return new LlmConnectivityResult(false, "No base URL configured");

        var chatUrl = raw.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)
            ? $"{raw}/chat/completions"
            : $"{raw}/v1/chat/completions";

        var model = string.IsNullOrWhiteSpace(setting.Model) ? OpenAiOfficialPingModel : setting.Model.Trim();
        var apiKey = setting.ApiKey?.Trim();
        if (string.IsNullOrEmpty(apiKey))
            return new LlmConnectivityResult(false, "No API key configured");

        return await SendOpenAiChatCompletionPingAsync(chatUrl, model, apiKey, ct);
    }

    private async Task<LlmConnectivityResult> SendOpenAiChatCompletionPingAsync(
        string url,
        string model,
        string apiKey,
        CancellationToken ct)
    {
        var client = _httpClientFactory.CreateClient("LlmConnectivity");
        var bodyObj = new
        {
            model,
            max_tokens = 1,
            messages = new[] { new { role = "user", content = "." } }
        };
        var json = JsonSerializer.Serialize(bodyObj);
        using var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);

        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await ReadOpenAiStyleErrorAsync(resp, ct);
            return new LlmConnectivityResult(false, err ?? $"HTTP {(int)resp.StatusCode}");
        }

        var body = await resp.Content.ReadAsStringAsync(ct);
        if (!TryValidateOpenAiChatCompletionBody(body, out var vf))
            return new LlmConnectivityResult(false, vf);
        return new LlmConnectivityResult(true, null);
    }

    /// <summary>Validates a real chat completion payload (not a public /models page).</summary>
    private static bool TryValidateOpenAiChatCompletionBody(string text, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(text))
        {
            error = "Empty response from API.";
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (!root.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0)
            {
                error = "Response is not a valid chat completion (missing choices). Check the API key and endpoint.";
                return false;
            }

            return true;
        }
        catch (JsonException)
        {
            error = "Response is not valid JSON. Check the base URL and API key.";
            return false;
        }
    }

    private static bool TryValidateAnthropicMessageBody(string text, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(text))
        {
            error = "Empty response from Anthropic API.";
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.TryGetProperty("type", out var t) && t.GetString() == "message")
                return true;

            if (root.TryGetProperty("error", out var errEl))
            {
                if (errEl.ValueKind == JsonValueKind.Object && errEl.TryGetProperty("message", out var m))
                    error = m.GetString();
                else if (errEl.ValueKind == JsonValueKind.String)
                    error = errEl.GetString();
                if (string.IsNullOrEmpty(error))
                    error = "Anthropic API returned an error.";
                return false;
            }

            error = "Unexpected Anthropic API response. Check the API key and model name.";
            return false;
        }
        catch (JsonException)
        {
            error = "Response is not valid JSON. Check the API key.";
            return false;
        }
    }

    private static bool TryValidateOllamaTagsBody(string text, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(text))
        {
            error = "Empty response from Ollama.";
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(text);
            if (!doc.RootElement.TryGetProperty("models", out var models) || models.ValueKind != JsonValueKind.Array)
            {
                error = "Unexpected Ollama /api/tags response.";
                return false;
            }

            return true;
        }
        catch (JsonException)
        {
            error = "Response is not valid JSON. Check the Ollama base URL.";
            return false;
        }
    }

    private static async Task<string?> ReadOpenAiStyleErrorAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        try
        {
            var text = await resp.Content.ReadAsStringAsync(ct);
            if (string.IsNullOrWhiteSpace(text)) return null;
            using var doc = JsonDocument.Parse(text);
            if (doc.RootElement.TryGetProperty("error", out var err))
            {
                if (err.ValueKind == JsonValueKind.Object && err.TryGetProperty("message", out var m))
                    return m.GetString();
                if (err.ValueKind == JsonValueKind.String)
                    return err.GetString();
            }
            return text.Length > 280 ? text[..280] + "…" : text;
        }
        catch
        {
            return null;
        }
    }

    private static async Task<string?> ReadAnthropicErrorAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        try
        {
            var text = await resp.Content.ReadAsStringAsync(ct);
            if (string.IsNullOrWhiteSpace(text)) return null;
            using var doc = JsonDocument.Parse(text);
            if (doc.RootElement.TryGetProperty("error", out var err) && err.TryGetProperty("message", out var m))
                return m.GetString();
            return text.Length > 280 ? text[..280] + "…" : text;
        }
        catch
        {
            return null;
        }
    }
}
