namespace DevPilot.Application.Services;

using DevPilot.Application.Constants;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;

/// <summary>Resolves the markdown agent rules string for sandbox creation.</summary>
public static class AgentRulesResolver
{
    public static async Task<string> ResolveAsync(
        Repository repository,
        Guid? storyId,
        string? requestAgentRules,
        IRepositoryAgentRuleRepository ruleRepository,
        IUserStoryRepository userStoryRepository,
        CancellationToken cancellationToken)
    {
        if (storyId.HasValue)
        {
            var story = await userStoryRepository.GetByIdAsync(storyId.Value, cancellationToken);
            if (story != null &&
                story.Feature?.Epic?.RepositoryId == repository.Id)
            {
                if (story.RepositoryAgentRuleId.HasValue)
                {
                    var picked = await ruleRepository.GetByIdAsync(story.RepositoryAgentRuleId.Value, cancellationToken);
                    if (picked != null && picked.RepositoryId == repository.Id && !string.IsNullOrEmpty(picked.Body))
                        return picked.Body;
                }

                var named = await ruleRepository.GetByRepositoryIdAsync(repository.Id, cancellationToken);
                var def = named.FirstOrDefault(r => r.IsDefault) ?? named.FirstOrDefault();
                if (def != null && !string.IsNullOrEmpty(def.Body))
                    return def.Body;
            }
        }

        var rules = await ruleRepository.GetByRepositoryIdAsync(repository.Id, cancellationToken);
        var defaultRule = rules.FirstOrDefault(r => r.IsDefault) ?? rules.FirstOrDefault();
        if (defaultRule != null && !string.IsNullOrEmpty(defaultRule.Body))
            return defaultRule.Body;

        if (!string.IsNullOrWhiteSpace(requestAgentRules))
            return requestAgentRules;

        if (!string.IsNullOrWhiteSpace(repository.AgentRules))
            return repository.AgentRules!;

        return DefaultAgentRules.Markdown;
    }
}
