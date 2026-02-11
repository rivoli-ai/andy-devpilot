namespace DevPilot.Application.Services;

/// <summary>
/// Resolves the effective AI config for a user, optionally scoped to a repository.
/// </summary>
public interface IEffectiveAiConfigResolver
{
    Task<EffectiveAiConfig> GetEffectiveConfigAsync(Guid userId, Guid? repositoryId, CancellationToken cancellationToken = default);
}

public record EffectiveAiConfig(string Provider, string? ApiKey, string? Model, string? BaseUrl);
