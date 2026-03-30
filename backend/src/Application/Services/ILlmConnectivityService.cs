namespace DevPilot.Application.Services;

using DevPilot.Domain.Entities;

/// <summary>
/// Lightweight connectivity check for stored LLM settings (no completion content persisted).
/// </summary>
public interface ILlmConnectivityService
{
    Task<LlmConnectivityResult> TestAsync(LlmSetting setting, CancellationToken cancellationToken = default);
}

public sealed record LlmConnectivityResult(bool Ok, string? ErrorMessage);
