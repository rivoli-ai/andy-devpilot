namespace DevPilot.Infrastructure.Services;

using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.Extensions.Logging;

public class EffectiveAiConfigResolver : IEffectiveAiConfigResolver
{
    private readonly IUserRepository _userRepository;
    private readonly ILlmSettingRepository _llmSettingRepository;
    private readonly IRepositoryRepository _repositoryRepository;
    private readonly ILogger<EffectiveAiConfigResolver> _logger;

    public EffectiveAiConfigResolver(
        IUserRepository userRepository,
        ILlmSettingRepository llmSettingRepository,
        IRepositoryRepository repositoryRepository,
        ILogger<EffectiveAiConfigResolver> logger)
    {
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
        _llmSettingRepository = llmSettingRepository ?? throw new ArgumentNullException(nameof(llmSettingRepository));
        _repositoryRepository = repositoryRepository ?? throw new ArgumentNullException(nameof(repositoryRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<EffectiveAiConfig> GetEffectiveConfigAsync(
        Guid userId,
        Guid? repositoryId,
        CancellationToken cancellationToken = default)
    {
        var user = await _userRepository.GetByIdAsync(userId, cancellationToken)
            ?? throw new InvalidOperationException("User not found");

        LlmSetting? llm = null;
        if (repositoryId.HasValue)
        {
            var repo = await _repositoryRepository.GetByIdAsync(repositoryId.Value, cancellationToken);
            _logger.LogInformation("[EffectiveAI] Repo {RepoId} LlmSettingId = {LlmSettingId}",
                repositoryId.Value, repo?.LlmSettingId?.ToString() ?? "(null)");

            if (repo?.LlmSettingId is { } settingId)
            {
                llm = await _llmSettingRepository.GetByIdAsync(settingId, cancellationToken);
                _logger.LogInformation("[EffectiveAI] Repo LLM found: Name={Name}, Provider={Provider}, Model={Model}",
                    llm?.Name, llm?.Provider, llm?.Model);
            }
        }

        if (llm == null)
        {
            llm = await _llmSettingRepository.GetDefaultByUserIdAsync(userId, cancellationToken);
            _logger.LogInformation("[EffectiveAI] Falling back to default LLM: Name={Name}, Provider={Provider}, Model={Model}",
                llm?.Name, llm?.Provider, llm?.Model);
        }

        // Fall back to user's preferred shared (admin-created) provider
        if (llm == null && user.PreferredSharedLlmSettingId.HasValue)
        {
            llm = await _llmSettingRepository.GetByIdAsync(user.PreferredSharedLlmSettingId.Value, cancellationToken);
            _logger.LogInformation("[EffectiveAI] Falling back to preferred shared LLM: Name={Name}, Provider={Provider}, Model={Model}",
                llm?.Name, llm?.Provider, llm?.Model);
        }

        if (llm != null && !string.IsNullOrEmpty(llm.ApiKey))
        {
            _logger.LogInformation("[EffectiveAI] Using LLM: {Name} ({Provider} / {Model})", llm.Name, llm.Provider, llm.Model);
            return new EffectiveAiConfig(
                llm.Provider,
                llm.ApiKey,
                llm.Model,
                llm.BaseUrl);
        }

        _logger.LogWarning("[EffectiveAI] No LLM configured, returning empty config");
        return new EffectiveAiConfig("openai", null, null, null);
    }
}
