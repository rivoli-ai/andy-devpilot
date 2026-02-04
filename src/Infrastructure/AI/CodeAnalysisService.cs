namespace DevPilot.Infrastructure.AI;

using System.Net.Http.Json;
using System.Text.Json;
using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using OpenAI;
using OpenAI.Chat;

/// <summary>
/// Service for AI-powered code analysis using sandbox infrastructure
/// Creates sandbox, sends analysis prompts, parses responses, and stores results
/// </summary>
public class CodeAnalysisService : ICodeAnalysisService
{
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly IUserRepository _userRepository;
    private readonly ICodeAnalysisRepository _codeAnalysisRepository;
    private readonly IFileAnalysisRepository _fileAnalysisRepository;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _configuration;
    private readonly ILogger<CodeAnalysisService> _logger;

    public CodeAnalysisService(
        IRepositoryRepository repositoryRepository,
        IUserRepository userRepository,
        ICodeAnalysisRepository codeAnalysisRepository,
        IFileAnalysisRepository fileAnalysisRepository,
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration,
        ILogger<CodeAnalysisService> logger)
    {
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
        _codeAnalysisRepository = codeAnalysisRepository ?? throw new ArgumentNullException(nameof(codeAnalysisRepository));
        _fileAnalysisRepository = fileAnalysisRepository ?? throw new ArgumentNullException(nameof(fileAnalysisRepository));
        _httpClientFactory = httpClientFactory ?? throw new ArgumentNullException(nameof(httpClientFactory));
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task<CodeAnalysisResult> AnalyzeRepositoryCodeAsync(
        Guid repositoryId,
        string? branch = null,
        CancellationToken cancellationToken = default)
    {
        var repository = await _repositoryRepository.GetByIdAsync(repositoryId, cancellationToken)
            ?? throw new InvalidOperationException($"Repository {repositoryId} not found");

        var effectiveBranch = branch ?? repository.DefaultBranch ?? "main";
        
        _logger.LogInformation("Starting code analysis for repository {RepositoryName} on branch {Branch}", 
            repository.Name, effectiveBranch);

        SandboxInfo? sandbox = null;
        try
        {
            // Create sandbox with repository cloned
            sandbox = await CreateSandboxAsync(repository, effectiveBranch, cancellationToken);
            
            // Wait for Zed to be ready
            await WaitForZedReadyAsync(sandbox.BridgePort, cancellationToken);
            
            // Send analysis prompt
            var prompt = BuildRepositoryAnalysisPrompt(repository.Name);
            await SendPromptAsync(sandbox.BridgePort, prompt, cancellationToken);
            
            // Wait and collect response
            var response = await WaitForResponseAsync(sandbox.BridgePort, cancellationToken);
            
            // Parse response and create/update analysis
            var result = ParseRepositoryAnalysisResponse(response, repositoryId, effectiveBranch);
            
            // Store in database
            var existing = await _codeAnalysisRepository.GetByRepositoryIdAsync(repositoryId, effectiveBranch, cancellationToken);
            if (existing != null)
            {
                existing.Update(
                    result.Summary,
                    result.Architecture,
                    result.KeyComponents,
                    result.Dependencies,
                    result.Recommendations,
                    result.Model);
                await _codeAnalysisRepository.UpdateAsync(existing, cancellationToken);
                result.Id = existing.Id;
            }
            else
            {
                var analysis = new CodeAnalysis(
                    repositoryId,
                    effectiveBranch,
                    result.Summary,
                    result.Architecture,
                    result.KeyComponents,
                    result.Dependencies,
                    result.Recommendations,
                    result.Model);
                await _codeAnalysisRepository.AddAsync(analysis, cancellationToken);
                result.Id = analysis.Id;
            }
            
            _logger.LogInformation("Code analysis completed for repository {RepositoryName}", repository.Name);
            return result;
        }
        finally
        {
            if (sandbox != null)
            {
                await DestroySandboxAsync(sandbox.ContainerId, cancellationToken);
            }
        }
    }

    public async Task<FileAnalysisResult> AnalyzeFileAsync(
        Guid repositoryId,
        Guid userId,
        string filePath,
        string fileContent,
        string? branch = null,
        CancellationToken cancellationToken = default)
    {
        var repository = await _repositoryRepository.GetByIdAsync(repositoryId, cancellationToken)
            ?? throw new InvalidOperationException($"Repository {repositoryId} not found");

        var user = await _userRepository.GetByIdAsync(userId, cancellationToken)
            ?? throw new InvalidOperationException($"User {userId} not found");

        var effectiveBranch = branch ?? repository.DefaultBranch ?? "main";
        
        _logger.LogInformation("Starting file analysis for {FilePath} in repository {RepositoryName}", 
            filePath, repository.Name);

        // Get user's AI settings (fallback to global config)
        var apiKey = user.AiApiKey ?? _configuration["AI:ApiKey"];
        var endpoint = user.AiBaseUrl ?? _configuration["AI:Endpoint"];
        var model = user.AiModel ?? _configuration["AI:Model"] ?? "gpt-4o-mini";

        if (string.IsNullOrEmpty(apiKey))
        {
            throw new InvalidOperationException("AI API key not configured. Please configure your AI settings.");
        }

        // Use direct AI chat completion (no sandbox needed)
        var response = await AnalyzeFileWithAIAsync(filePath, fileContent, apiKey, endpoint, model, cancellationToken);
        
        // Parse response
        var result = ParseFileAnalysisResponse(response, repositoryId, filePath, effectiveBranch);
        
        // Store in database
        var existing = await _fileAnalysisRepository.GetByRepositoryAndPathAsync(repositoryId, filePath, effectiveBranch, cancellationToken);
        if (existing != null)
        {
            existing.Update(
                result.Explanation,
                result.KeyFunctions,
                result.Complexity,
                result.Suggestions,
                result.Model);
            await _fileAnalysisRepository.UpdateAsync(existing, cancellationToken);
            result.Id = existing.Id;
        }
        else
        {
            var analysis = new FileAnalysis(
                repositoryId,
                filePath,
                effectiveBranch,
                result.Explanation,
                result.KeyFunctions,
                result.Complexity,
                result.Suggestions,
                result.Model);
            await _fileAnalysisRepository.AddAsync(analysis, cancellationToken);
            result.Id = analysis.Id;
        }
        
        _logger.LogInformation("File analysis completed for {FilePath}", filePath);
        return result;
    }

    public async Task<CodeAnalysisResult?> GetStoredAnalysisAsync(
        Guid repositoryId,
        string? branch = null,
        CancellationToken cancellationToken = default)
    {
        var analysis = await _codeAnalysisRepository.GetByRepositoryIdAsync(repositoryId, branch, cancellationToken);
        if (analysis == null) return null;

        return new CodeAnalysisResult
        {
            Id = analysis.Id,
            RepositoryId = analysis.RepositoryId,
            Branch = analysis.Branch,
            Summary = analysis.Summary,
            Architecture = analysis.Architecture,
            KeyComponents = analysis.KeyComponents,
            Dependencies = analysis.Dependencies,
            Recommendations = analysis.Recommendations,
            AnalyzedAt = analysis.AnalyzedAt,
            Model = analysis.Model
        };
    }

    public async Task<FileAnalysisResult?> GetStoredFileAnalysisAsync(
        Guid repositoryId,
        string filePath,
        string? branch = null,
        CancellationToken cancellationToken = default)
    {
        var analysis = await _fileAnalysisRepository.GetByRepositoryAndPathAsync(repositoryId, filePath, branch, cancellationToken);
        if (analysis == null) return null;

        return new FileAnalysisResult
        {
            Id = analysis.Id,
            RepositoryId = analysis.RepositoryId,
            FilePath = analysis.FilePath,
            Branch = analysis.Branch,
            Explanation = analysis.Explanation,
            KeyFunctions = analysis.KeyFunctions,
            Complexity = analysis.Complexity,
            Suggestions = analysis.Suggestions,
            AnalyzedAt = analysis.AnalyzedAt,
            Model = analysis.Model
        };
    }

    public async System.Threading.Tasks.Task DeleteAnalysisAsync(
        Guid repositoryId,
        CancellationToken cancellationToken = default)
    {
        await _codeAnalysisRepository.DeleteByRepositoryIdAsync(repositoryId, cancellationToken);
        await _fileAnalysisRepository.DeleteByRepositoryIdAsync(repositoryId, cancellationToken);
    }

    public async Task<CodeAnalysisResult> SaveAnalysisResultAsync(
        Guid repositoryId,
        string? branch,
        string summary,
        string? architecture,
        string? keyComponents,
        string? dependencies,
        string? recommendations,
        string? model,
        CancellationToken cancellationToken = default)
    {
        var repository = await _repositoryRepository.GetByIdAsync(repositoryId, cancellationToken)
            ?? throw new InvalidOperationException($"Repository {repositoryId} not found");

        var effectiveBranch = branch ?? repository.DefaultBranch ?? "main";

        _logger.LogInformation("Saving analysis result for repository {RepositoryName} on branch {Branch}",
            repository.Name, effectiveBranch);

        // Check for existing analysis
        var existing = await _codeAnalysisRepository.GetByRepositoryIdAsync(repositoryId, effectiveBranch, cancellationToken);
        
        CodeAnalysisResult result;
        
        if (existing != null)
        {
            // Update existing
            existing.Update(summary, architecture, keyComponents, dependencies, recommendations, model);
            await _codeAnalysisRepository.UpdateAsync(existing, cancellationToken);
            
            result = new CodeAnalysisResult
            {
                Id = existing.Id,
                RepositoryId = repositoryId,
                Branch = effectiveBranch,
                Summary = summary,
                Architecture = architecture,
                KeyComponents = keyComponents,
                Dependencies = dependencies,
                Recommendations = recommendations,
                AnalyzedAt = existing.AnalyzedAt,
                Model = model
            };
        }
        else
        {
            // Create new
            var analysis = new CodeAnalysis(
                repositoryId,
                effectiveBranch,
                summary,
                architecture,
                keyComponents,
                dependencies,
                recommendations,
                model);
            
            await _codeAnalysisRepository.AddAsync(analysis, cancellationToken);
            
            result = new CodeAnalysisResult
            {
                Id = analysis.Id,
                RepositoryId = repositoryId,
                Branch = effectiveBranch,
                Summary = summary,
                Architecture = architecture,
                KeyComponents = keyComponents,
                Dependencies = dependencies,
                Recommendations = recommendations,
                AnalyzedAt = analysis.AnalyzedAt,
                Model = model
            };
        }

        _logger.LogInformation("Analysis saved successfully for repository {RepositoryId}", repositoryId);
        return result;
    }

    #region Private Methods

    private string GetSandboxApiUrl()
    {
        return _configuration["VPS:GatewayUrl"] ?? "http://localhost:8090";
    }

    /// <summary>
    /// Analyze file content using direct AI chat completion
    /// </summary>
    private async Task<string> AnalyzeFileWithAIAsync(
        string filePath, 
        string fileContent, 
        string apiKey, 
        string? endpoint, 
        string model, 
        CancellationToken cancellationToken)
    {
        // Create OpenAI client with optional custom endpoint
        ChatClient client;
        if (!string.IsNullOrEmpty(endpoint))
        {
            var clientOptions = new OpenAIClientOptions
            {
                Endpoint = new Uri(endpoint)
            };
            client = new ChatClient(
                model: model,
                credential: new System.ClientModel.ApiKeyCredential(apiKey),
                options: clientOptions
            );
        }
        else
        {
            client = new ChatClient(model, apiKey);
        }

        var systemMessage = @"You are an expert code analyst. Analyze the provided file and explain what it does.
Provide your response in markdown format with the following sections:
## Explanation
A clear explanation of what this file does and its role in the project.

## Key Functions/Classes
List the main functions, classes, or components with brief descriptions.

## Complexity
Rate the complexity as Low/Medium/High and briefly explain why.

## Suggestions
Any suggestions for improving this file (if applicable).";

        var userMessage = $"Analyze this file: `{filePath}`\n\n```\n{fileContent}\n```";

        var chatOptions = new ChatCompletionOptions
        {
            Temperature = 0.3f
        };

        var messages = new List<ChatMessage>
        {
            new SystemChatMessage(systemMessage),
            new UserChatMessage(userMessage)
        };

        _logger.LogDebug("Sending file analysis request to AI for {FilePath} using model {Model}", filePath, model);
        
        var response = await client.CompleteChatAsync(messages, chatOptions, cancellationToken);
        
        return response.Value.Content[0].Text;
    }

    private async Task<SandboxInfo> CreateSandboxAsync(Repository repository, string branch, CancellationToken cancellationToken)
    {
        var client = _httpClientFactory.CreateClient();
        var sandboxUrl = GetSandboxApiUrl();

        var request = new
        {
            repo_url = repository.CloneUrl,
            repo_name = repository.Name,
            repo_branch = branch,
            resolution = "1920x1080x24"
        };

        _logger.LogDebug("Creating sandbox at {Url} for repository {RepoName}", sandboxUrl, repository.Name);

        var response = await client.PostAsJsonAsync($"{sandboxUrl}/sandboxes", request, cancellationToken);
        response.EnsureSuccessStatusCode();

        var result = await response.Content.ReadFromJsonAsync<SandboxCreateResponse>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("Failed to parse sandbox creation response");

        return new SandboxInfo
        {
            ContainerId = result.id,
            BridgePort = result.bridge_port
        };
    }

    private async System.Threading.Tasks.Task DestroySandboxAsync(string containerId, CancellationToken cancellationToken)
    {
        try
        {
            var client = _httpClientFactory.CreateClient();
            var sandboxUrl = GetSandboxApiUrl();

            await client.DeleteAsync($"{sandboxUrl}/sandboxes/{containerId}", cancellationToken);
            _logger.LogDebug("Destroyed sandbox {ContainerId}", containerId);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to destroy sandbox {ContainerId}", containerId);
        }
    }

    private async System.Threading.Tasks.Task WaitForZedReadyAsync(int bridgePort, CancellationToken cancellationToken)
    {
        var client = _httpClientFactory.CreateClient();
        var bridgeUrl = $"http://localhost:{bridgePort}";
        var maxAttempts = 30;
        var delayMs = 3000;

        for (int attempt = 0; attempt < maxAttempts; attempt++)
        {
            try
            {
                var response = await client.GetAsync($"{bridgeUrl}/health", cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    var health = await response.Content.ReadFromJsonAsync<HealthResponse>(cancellationToken: cancellationToken);
                    if (health?.zed_running == true && !string.IsNullOrEmpty(health.zed_window_id))
                    {
                        _logger.LogDebug("Zed is ready on port {Port}", bridgePort);
                        return;
                    }
                }
            }
            catch
            {
                // Ignore and retry
            }

            await System.Threading.Tasks.Task.Delay(delayMs, cancellationToken);
        }

        throw new TimeoutException($"Zed did not become ready within {maxAttempts * delayMs / 1000} seconds");
    }

    private async System.Threading.Tasks.Task SendPromptAsync(int bridgePort, string prompt, CancellationToken cancellationToken)
    {
        var client = _httpClientFactory.CreateClient();
        var bridgeUrl = $"http://localhost:{bridgePort}";

        var response = await client.PostAsJsonAsync($"{bridgeUrl}/zed/send-prompt", new { prompt }, cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    private async Task<string> WaitForResponseAsync(int bridgePort, CancellationToken cancellationToken)
    {
        var client = _httpClientFactory.CreateClient();
        var bridgeUrl = $"http://localhost:{bridgePort}";
        var maxAttempts = 60;
        var delayMs = 2000;
        var initialConversationCount = 0;

        // Get initial conversation count
        try
        {
            var initialResponse = await client.GetFromJsonAsync<ConversationsResponse>($"{bridgeUrl}/all-conversations", cancellationToken);
            initialConversationCount = initialResponse?.count ?? 0;
        }
        catch { }

        for (int attempt = 0; attempt < maxAttempts; attempt++)
        {
            try
            {
                var response = await client.GetFromJsonAsync<ConversationsResponse>($"{bridgeUrl}/all-conversations", cancellationToken);
                if (response != null && response.count > initialConversationCount && response.conversations.Count > 0)
                {
                    var lastConversation = response.conversations[^1];
                    if (!string.IsNullOrEmpty(lastConversation.assistant_message))
                    {
                        _logger.LogDebug("Received response after {Attempts} attempts", attempt + 1);
                        return lastConversation.assistant_message;
                    }
                }
            }
            catch
            {
                // Ignore and retry
            }

            await System.Threading.Tasks.Task.Delay(delayMs, cancellationToken);
        }

        throw new TimeoutException($"No response received within {maxAttempts * delayMs / 1000} seconds");
    }

    private static string BuildRepositoryAnalysisPrompt(string repoName)
    {
        return $@"Analyze this codebase and provide a comprehensive analysis in the following format:

## Summary
Provide a 2-3 paragraph summary of what this project does, its main purpose, and key technologies used.

## Architecture
Describe the overall architecture, design patterns used, and how the main components interact.

## Key Components
List the main components/modules with brief descriptions:
- Component 1: Description
- Component 2: Description
(etc.)

## Dependencies
List key external dependencies and their purposes.

## Recommendations
Provide 3-5 actionable recommendations for improving the codebase (code quality, architecture, testing, documentation, etc.)

Please analyze the repository '{repoName}' thoroughly by reading the key files.";
    }

    private static string BuildFileAnalysisPrompt(string filePath)
    {
        return $@"Analyze the file '{filePath}' and provide an explanation in the following format:

## Explanation
Provide a clear explanation of what this file does and its role in the project.

## Key Functions/Classes
List the main functions, classes, or components with brief descriptions:
- function/class name: Description
(etc.)

## Complexity
Rate the complexity as Low/Medium/High and briefly explain why.

## Suggestions
Provide any suggestions for improving this file (if any).

Please read and analyze the file '{filePath}' thoroughly.";
    }

    private CodeAnalysisResult ParseRepositoryAnalysisResponse(string response, Guid repositoryId, string branch)
    {
        // Parse markdown sections from the response
        var sections = ParseMarkdownSections(response);

        return new CodeAnalysisResult
        {
            RepositoryId = repositoryId,
            Branch = branch,
            Summary = sections.GetValueOrDefault("Summary", response),
            Architecture = sections.GetValueOrDefault("Architecture"),
            KeyComponents = sections.GetValueOrDefault("Key Components"),
            Dependencies = sections.GetValueOrDefault("Dependencies"),
            Recommendations = sections.GetValueOrDefault("Recommendations"),
            AnalyzedAt = DateTime.UtcNow,
            Model = _configuration["AI:Model"] ?? "gpt-4o"
        };
    }

    private FileAnalysisResult ParseFileAnalysisResponse(string response, Guid repositoryId, string filePath, string branch)
    {
        var sections = ParseMarkdownSections(response);

        return new FileAnalysisResult
        {
            RepositoryId = repositoryId,
            FilePath = filePath,
            Branch = branch,
            Explanation = sections.GetValueOrDefault("Explanation", response),
            KeyFunctions = sections.GetValueOrDefault("Key Functions/Classes") ?? sections.GetValueOrDefault("Key Functions"),
            Complexity = sections.GetValueOrDefault("Complexity"),
            Suggestions = sections.GetValueOrDefault("Suggestions"),
            AnalyzedAt = DateTime.UtcNow,
            Model = _configuration["AI:Model"] ?? "gpt-4o"
        };
    }

    private static Dictionary<string, string> ParseMarkdownSections(string markdown)
    {
        var sections = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var lines = markdown.Split('\n');
        string? currentSection = null;
        var currentContent = new List<string>();

        foreach (var line in lines)
        {
            if (line.StartsWith("## "))
            {
                // Save previous section
                if (currentSection != null && currentContent.Count > 0)
                {
                    sections[currentSection] = string.Join("\n", currentContent).Trim();
                }

                currentSection = line.Substring(3).Trim();
                currentContent.Clear();
            }
            else if (currentSection != null)
            {
                currentContent.Add(line);
            }
        }

        // Save last section
        if (currentSection != null && currentContent.Count > 0)
        {
            sections[currentSection] = string.Join("\n", currentContent).Trim();
        }

        return sections;
    }

    #endregion

    #region Response Models

    private class SandboxCreateResponse
    {
        public string id { get; set; } = "";
        public int port { get; set; }
        public int bridge_port { get; set; }
    }

    private class SandboxInfo
    {
        public string ContainerId { get; set; } = "";
        public int BridgePort { get; set; }
    }

    private class HealthResponse
    {
        public string status { get; set; } = "";
        public bool zed_running { get; set; }
        public string? zed_window_id { get; set; }
    }

    private class ConversationsResponse
    {
        public List<ConversationEntry> conversations { get; set; } = new();
        public int count { get; set; }
    }

    private class ConversationEntry
    {
        public string id { get; set; } = "";
        public string user_message { get; set; } = "";
        public string assistant_message { get; set; } = "";
    }

    #endregion
}
