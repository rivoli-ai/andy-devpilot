namespace DevPilot.Infrastructure.AI;

using DevPilot.Application.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using System.Text.Json;
using System.Text.Json.Serialization;
using OpenAI;
using OpenAI.Chat;
using System.ClientModel.Primitives;

/// <summary>
/// Implementation of IAnalysisService using OpenAI-compatible API.
/// Uses the repository's linked LLM (default or custom) via IEffectiveAiConfigResolver.
/// </summary>
public class AnalysisService : IAnalysisService
{
    private readonly IConfiguration _configuration;
    private readonly IEffectiveAiConfigResolver _effectiveAiConfigResolver;
    private readonly ILogger<AnalysisService> _logger;

    public AnalysisService(
        IConfiguration configuration,
        IEffectiveAiConfigResolver effectiveAiConfigResolver,
        ILogger<AnalysisService> logger)
    {
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
        _effectiveAiConfigResolver = effectiveAiConfigResolver ?? throw new ArgumentNullException(nameof(effectiveAiConfigResolver));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<RepositoryAnalysisResult> AnalyzeRepositoryAsync(
        Guid userId,
        Guid repositoryId,
        string repositoryContent,
        string repositoryName,
        CancellationToken cancellationToken = default)
    {
        try
        {
            // Use repository's linked LLM (default or custom)
            var config = await _effectiveAiConfigResolver.GetEffectiveConfigAsync(userId, repositoryId, cancellationToken);
            var apiKey = !string.IsNullOrEmpty(config.ApiKey) ? config.ApiKey : _configuration["AI:ApiKey"];
            var endpoint = !string.IsNullOrEmpty(config.BaseUrl) ? config.BaseUrl : _configuration["AI:Endpoint"];
            var model = !string.IsNullOrEmpty(config.Model) ? config.Model : (_configuration["AI:Model"] ?? "gpt-4o-mini");

            if (string.IsNullOrEmpty(apiKey))
            {
                throw new InvalidOperationException("AI API key not configured. Please add an AI provider in Settings.");
            }

            // Build deterministic prompt
            var prompt = BuildAnalysisPrompt(repositoryContent, repositoryName);

            // Create OpenAI client with optional custom endpoint
            ChatClient client;

            if (!string.IsNullOrEmpty(endpoint))
            {
                // Custom endpoint (OpenAI-compatible like Hugging Face)
                var clientOptions = new OpenAIClientOptions
                {
                    Endpoint = new Uri(endpoint)
                };
               client = new(
                    model: model,
                    credential: new System.ClientModel.ApiKeyCredential(apiKey),
                    options: clientOptions
                );
            }
            else
            {
                // Standard OpenAI (api.openai.com)
                client = new ChatClient(model, apiKey);
            }

            // Prepare chat messages - using string messages directly
            var systemMessage = "You are a software architect that analyzes code repositories and generates structured work items. " +
                "Always respond with valid JSON only. Your responses must follow the exact structure specified in the prompt. " +
                "Do not include any markdown formatting, code blocks, or explanatory text - only return valid JSON.";

            // Call AI with deterministic prompt
            var chatOptions = new ChatCompletionOptions
            {
                Temperature = 0.3f // Lower temperature for more deterministic output
            };

            // Request JSON format if supported
            chatOptions.ResponseFormat = ChatResponseFormat.CreateJsonObjectFormat();


            var messages = new List<ChatMessage>
            {
                new SystemChatMessage(systemMessage),
                new UserChatMessage(prompt)
            };
            var response = await client.CompleteChatAsync(
                 messages,
                chatOptions,
                cancellationToken);

            var content = response.Value.Content[0].Text;

            // Parse structured JSON response
            var options = new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
                DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
            };

            var result = JsonSerializer.Deserialize<RepositoryAnalysisResult>(content, options);

            if (result == null)
            {
                throw new InvalidOperationException("Failed to parse AI response as structured JSON");
            }

            _logger.LogInformation("Successfully analyzed repository {RepositoryName} with model {Model}", 
                repositoryName, model);

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error analyzing repository {RepositoryName}", repositoryName);
            throw;
        }
    }

    /// <summary>
    /// Builds a deterministic prompt for repository analysis
    /// Ensures consistent output format with structured JSON
    /// </summary>
    private string BuildAnalysisPrompt(string repositoryContent, string repositoryName)
    {
        return $@"Analyze the following repository '{repositoryName}' and generate structured work items.

Repository Content Summary:
{repositoryContent}

Based on the repository structure, code patterns, and functionality, generate:

1. Epics - Large bodies of work that organize related features
2. Features - Major functionalities that belong to an Epic
3. User Stories - Requirements from the user's perspective with acceptance criteria
4. Tasks - Specific work items with complexity assessment (Simple/Medium/Complex)

Provide your analysis in the following JSON structure:
{{
  ""reasoning"": ""Brief explanation of your analysis approach"",
  ""epics"": [
    {{
      ""title"": ""Epic Title"",
      ""description"": ""Epic description"",
      ""features"": [
        {{
          ""title"": ""Feature Title"",
          ""description"": ""Feature description"",
          ""userStories"": [
            {{
              ""title"": ""As a [user], I want [goal] so that [benefit]"",
              ""description"": ""User story description"",
              ""acceptanceCriteria"": ""Criteria 1, Criteria 2, Criteria 3"",
              ""tasks"": [
                {{
                  ""title"": ""Task title"",
                  ""description"": ""Task description"",
                  ""complexity"": ""Simple|Medium|Complex""
                }}
              ]
            }}
          ]
        }}
      ]
    }}
  ],
  ""metadata"": {{
    ""analysisTimestamp"": ""{DateTime.UtcNow:yyyy-MM-ddTHH:mm:ssZ}"",
    ""model"": ""gpt-4o-mini"",
    ""reasoning"": ""Why these items were generated""
  }}
}}

Return ONLY valid JSON, no additional text or markdown formatting.";
    }
}
