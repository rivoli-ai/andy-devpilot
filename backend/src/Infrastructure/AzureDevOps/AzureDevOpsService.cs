namespace DevPilot.Infrastructure.AzureDevOps;

using System.Linq;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using DevPilot.Application.Services;
using Microsoft.Extensions.Logging;

/// <summary>
/// Implementation of IAzureDevOpsService
/// Handles communication with Azure DevOps REST API
/// </summary>
public class AzureDevOpsService : IAzureDevOpsService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<AzureDevOpsService> _logger;
    private const string AzureDevOpsApiVersion = "7.0";
    private const string ClassificationTreeAreas = "Areas";
    private const string ClassificationTreeIterations = "Iterations";

    public AzureDevOpsService(
        IHttpClientFactory httpClientFactory,
        ILogger<AzureDevOpsService> logger)
    {
        _httpClientFactory = httpClientFactory ?? throw new ArgumentNullException(nameof(httpClientFactory));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async System.Threading.Tasks.Task<IEnumerable<AzureDevOpsOrganizationDto>> GetOrganizationsAsync(
        string accessToken,
        CancellationToken cancellationToken = default)
    {
        var httpClient = CreateHttpClient(accessToken);

        try
        {
            // First get the user's profile to get their member ID
            var profileResponse = await httpClient.GetAsync(
                "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=6.0",
                cancellationToken);
            
            profileResponse.EnsureSuccessStatusCode();
            var profileContent = await profileResponse.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogInformation("Azure DevOps profile response: {Response}", profileContent);
            
            var profile = JsonDocument.Parse(profileContent);
            var memberId = profile.RootElement.GetProperty("id").GetString();
            _logger.LogInformation("Azure DevOps member ID: {MemberId}", memberId);

            // Get accounts (organizations) for this member
            var accountsResponse = await httpClient.GetAsync(
                $"https://app.vssps.visualstudio.com/_apis/accounts?memberId={Uri.EscapeDataString(memberId!)}&api-version=6.0",
                cancellationToken);

            accountsResponse.EnsureSuccessStatusCode();
            var accountsContent = await accountsResponse.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogInformation("Azure DevOps accounts response: {Response}", accountsContent);
            
            var accounts = JsonDocument.Parse(accountsContent);

            var result = new List<AzureDevOpsOrganizationDto>();
            
            // Check if "value" property exists
            if (accounts.RootElement.TryGetProperty("value", out var valueArray))
            {
                foreach (var account in valueArray.EnumerateArray())
                {
                    result.Add(new AzureDevOpsOrganizationDto
                    {
                        AccountId = account.GetProperty("accountId").GetString() ?? "",
                        AccountName = account.GetProperty("accountName").GetString() ?? "",
                        AccountUri = account.GetProperty("accountUri").GetString() ?? ""
                    });
                }
            }
            
            _logger.LogInformation("Found {Count} Azure DevOps organizations", result.Count);

            if (result.Count == 0)
            {
                _logger.LogWarning("No Azure DevOps organizations found for this user. Make sure the Microsoft account has access to Azure DevOps organizations.");
            }

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching organizations from Azure DevOps");
            throw;
        }
    }

    public async System.Threading.Tasks.Task<IEnumerable<AzureDevOpsProjectDto>> GetProjectsAsync(
        string accessToken,
        string organization,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);

        try
        {
            var response = await httpClient.GetAsync(
                $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/_apis/projects?api-version={AzureDevOpsApiVersion}",
                cancellationToken);

            var content = await response.Content.ReadAsStringAsync(cancellationToken);
            
            // Log the response for debugging
            _logger.LogInformation("Azure DevOps projects API response status: {StatusCode}", response.StatusCode);
            
            // Check if response is HTML (login page) instead of JSON
            if (content.TrimStart().StartsWith("<") || content.TrimStart().StartsWith("<!"))
            {
                _logger.LogError("Azure DevOps returned HTML instead of JSON. This usually means authentication failed. Status: {StatusCode}", response.StatusCode);
                throw new InvalidOperationException($"Azure DevOps authentication failed for organization '{organization}'. The token may not have access to this organization. Please ensure you have been added to this Azure DevOps organization with your Microsoft account.");
            }
            
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Azure DevOps projects API failed: {StatusCode} - {Content}", response.StatusCode, content);
                throw new HttpRequestException($"Azure DevOps API returned {response.StatusCode}: {content}");
            }

            var projects = JsonDocument.Parse(content);

            var result = new List<AzureDevOpsProjectDto>();
            if (projects.RootElement.TryGetProperty("value", out var valueArray))
            {
                foreach (var project in valueArray.EnumerateArray())
                {
                    result.Add(new AzureDevOpsProjectDto
                    {
                        Id = project.GetProperty("id").GetString() ?? "",
                        Name = project.GetProperty("name").GetString() ?? "",
                        Description = project.TryGetProperty("description", out var desc) ? desc.GetString() : null,
                        State = project.GetProperty("state").GetString() ?? "unknown"
                    });
                }
            }
            
            _logger.LogInformation("Found {Count} projects in organization {Organization}", result.Count, organization);

            return result;
        }
        catch (InvalidOperationException)
        {
            throw; // Re-throw our custom exception
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching projects from Azure DevOps for organization {Organization}", organization);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<IEnumerable<AzureDevOpsRepositoryDto>> GetRepositoriesAsync(
        string accessToken,
        CancellationToken cancellationToken = default)
    {
        var httpClient = CreateHttpClient(accessToken);

        try
        {
            // Get all organizations first
            var organizations = await GetOrganizationsAsync(accessToken, cancellationToken);
            var allRepos = new List<AzureDevOpsRepositoryDto>();

            foreach (var org in organizations)
            {
                try
                {
                    // Get all projects in the organization
                    var projects = await GetProjectsAsync(accessToken, org.AccountName, cancellationToken);

                    foreach (var project in projects)
                    {
                        var repos = await GetProjectRepositoriesAsync(
                            accessToken, 
                            org.AccountName, 
                            project.Name, 
                            cancellationToken);
                        allRepos.AddRange(repos);
                    }
                }
                catch (Exception ex)
                {
                    // Log but continue with other organizations
                    _logger.LogWarning(ex, "Error fetching repositories for organization {Organization}", org.AccountName);
                }
            }

            return allRepos;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching all repositories from Azure DevOps");
            throw;
        }
    }

    public async System.Threading.Tasks.Task<IEnumerable<AzureDevOpsRepositoryDto>> GetProjectRepositoriesAsync(
        string accessToken,
        string organization,
        string project,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);

        try
        {
            var response = await httpClient.GetAsync(
                $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/git/repositories?api-version={AzureDevOpsApiVersion}",
                cancellationToken);

            response.EnsureSuccessStatusCode();
            var content = await response.Content.ReadAsStringAsync(cancellationToken);
            var repos = JsonDocument.Parse(content);

            var result = new List<AzureDevOpsRepositoryDto>();
            foreach (var repo in repos.RootElement.GetProperty("value").EnumerateArray())
            {
                result.Add(new AzureDevOpsRepositoryDto
                {
                    Id = repo.GetProperty("id").GetString() ?? "",
                    Name = repo.GetProperty("name").GetString() ?? "",
                    RemoteUrl = repo.TryGetProperty("remoteUrl", out var remoteUrl) ? remoteUrl.GetString() ?? "" : "",
                    WebUrl = repo.TryGetProperty("webUrl", out var webUrl) ? webUrl.GetString() ?? "" : "",
                    ProjectName = project,
                    OrganizationName = organization,
                    DefaultBranch = repo.TryGetProperty("defaultBranch", out var defaultBranch) 
                        ? defaultBranch.GetString()?.Replace("refs/heads/", "") 
                        : "main",
                    IsDisabled = repo.TryGetProperty("isDisabled", out var isDisabled) && isDisabled.GetBoolean()
                });
            }

            return result.Where(r => !r.IsDisabled);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching repositories from Azure DevOps for {Organization}/{Project}", organization, project);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<AzureDevOpsPullRequestDto> CreatePullRequestAsync(
        string accessToken,
        string organization,
        string project,
        string repositoryId,
        string sourceBranch,
        string targetBranch,
        string title,
        string? description = null,
        IReadOnlyList<int>? workItemIds = null,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);

        try
        {
            // Ensure branches have refs/heads/ prefix
            var sourceRef = sourceBranch.StartsWith("refs/heads/") ? sourceBranch : $"refs/heads/{sourceBranch}";
            var targetRef = targetBranch.StartsWith("refs/heads/") ? targetBranch : $"refs/heads/{targetBranch}";

            var prPayload = new
            {
                sourceRefName = sourceRef,
                targetRefName = targetRef,
                title = title,
                description = description ?? ""
            };

            var jsonContent = new StringContent(
                JsonSerializer.Serialize(prPayload),
                Encoding.UTF8,
                "application/json");

            var url = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/git/repositories/{AzureDevOpsPathSegment(repositoryId, nameof(repositoryId))}/pullrequests?api-version={AzureDevOpsApiVersion}";
            _logger.LogInformation("Creating pull request at {Url}", url);
            
            var response = await httpClient.PostAsync(url, jsonContent, cancellationToken);

            var content = await response.Content.ReadAsStringAsync(cancellationToken);
            
            // Check if response is HTML (error page) instead of JSON
            if (content.TrimStart().StartsWith("<") || content.TrimStart().StartsWith("<!"))
            {
                _logger.LogError("Azure DevOps returned HTML instead of JSON. Status: {StatusCode}. This usually indicates an authentication issue.", response.StatusCode);
                throw new InvalidOperationException($"Azure DevOps authentication failed (HTTP {(int)response.StatusCode}). Please check your PAT or reconnect your Azure DevOps account.");
            }
            
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Azure DevOps PR creation failed. Status: {StatusCode}, Response: {Content}", response.StatusCode, content);
                throw new InvalidOperationException($"Failed to create pull request: {content}");
            }
            
            var pr = JsonDocument.Parse(content);

            var prId = pr.RootElement.GetProperty("pullRequestId").GetInt32();
            var prUrl = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_git/{AzureDevOpsPathSegment(repositoryId, nameof(repositoryId))}/pullrequest/{prId}";

            // Link work items to the PR so they appear as Related Work Items
            var artifactId = pr.RootElement.TryGetProperty("artifactId", out var aidProp) ? aidProp.GetString() : null;
            if (!string.IsNullOrEmpty(artifactId) && workItemIds != null && workItemIds.Count > 0)
            {
                foreach (var workItemId in workItemIds)
                {
                    try
                    {
                        var patchPayload = new[]
                        {
                            new
                            {
                                op = "add",
                                path = "/relations/-",
                                value = new
                                {
                                    rel = "ArtifactLink",
                                    url = artifactId,
                                    attributes = new { name = "pull request" }
                                }
                            }
                        };
                        var patchContent = new StringContent(
                            JsonSerializer.Serialize(patchPayload),
                            Encoding.UTF8,
                            "application/json-patch+json");
                        var witUrl = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/wit/workitems/{workItemId}?api-version={AzureDevOpsApiVersion}";
                        var patchResponse = await httpClient.PatchAsync(witUrl, patchContent, cancellationToken);
                        if (patchResponse.IsSuccessStatusCode)
                            _logger.LogInformation("Linked work item {WorkItemId} to PR {PrId}", workItemId, prId);
                        else
                            _logger.LogWarning("Failed to link work item {WorkItemId} to PR: {StatusCode}", workItemId, patchResponse.StatusCode);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Failed to link work item {WorkItemId} to PR {PrId}", workItemId, prId);
                    }
                }
            }

            return new AzureDevOpsPullRequestDto
            {
                PullRequestId = prId,
                Url = prUrl,
                Title = pr.RootElement.GetProperty("title").GetString() ?? title,
                Status = pr.RootElement.GetProperty("status").GetString() ?? "active"
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error creating pull request in Azure DevOps for {Organization}/{Project}/{Repository}", 
                organization, project, repositoryId);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<IEnumerable<AzureDevOpsTeamDto>> GetTeamsAsync(
        string accessToken,
        string organization,
        string project,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);

        try
        {
            var response = await httpClient.GetAsync(
                $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/_apis/projects/{AzureDevOpsPathSegment(project, nameof(project))}/teams?api-version={AzureDevOpsApiVersion}",
                cancellationToken);

            var content = await response.Content.ReadAsStringAsync(cancellationToken);

            // Check for HTML response (authentication failure)
            if (content.TrimStart().StartsWith("<") || content.TrimStart().StartsWith("<!"))
            {
                _logger.LogError("Azure DevOps returned HTML instead of JSON for teams query");
                throw new InvalidOperationException($"Azure DevOps authentication failed for organization '{organization}'. Please check your PAT.");
            }

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Azure DevOps teams API failed: {StatusCode} - {Content}", response.StatusCode, content);
                throw new HttpRequestException($"Azure DevOps API returned {response.StatusCode}: {content}");
            }

            var teams = JsonDocument.Parse(content);
            var result = new List<AzureDevOpsTeamDto>();

            if (teams.RootElement.TryGetProperty("value", out var valueArray))
            {
                foreach (var team in valueArray.EnumerateArray())
                {
                    result.Add(new AzureDevOpsTeamDto
                    {
                        Id = team.GetProperty("id").GetString() ?? "",
                        Name = team.GetProperty("name").GetString() ?? "",
                        Description = team.TryGetProperty("description", out var desc) ? desc.GetString() : null,
                        ProjectName = project,
                        ProjectId = team.TryGetProperty("projectId", out var projId) ? projId.GetString() : null
                    });
                }
            }

            _logger.LogInformation("Found {Count} teams in project {Organization}/{Project}", result.Count, organization, project);
            return result;
        }
        catch (InvalidOperationException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching teams from Azure DevOps for {Organization}/{Project}", organization, project);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<IReadOnlyList<AzureDevOpsAreaPathOptionDto>> GetProjectAreaPathsAsync(
        string accessToken,
        string organization,
        string project,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);
        using var doc = await FetchClassificationTreeDocumentAsync(
            httpClient, organization, project, ClassificationTreeAreas, cancellationToken);
        if (doc is null)
        {
            return Array.Empty<AzureDevOpsAreaPathOptionDto>();
        }

        var list = new List<AzureDevOpsAreaPathOptionDto>();
        CollectAreaPathOptionsFromClassificationNode(doc.RootElement, list);
        return list.OrderBy(o => o.Path, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public async System.Threading.Tasks.Task<IReadOnlyList<AzureDevOpsAreaPathOptionDto>> GetProjectIterationPathsAsync(
        string accessToken,
        string organization,
        string project,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);
        using var doc = await FetchClassificationTreeDocumentAsync(
            httpClient, organization, project, ClassificationTreeIterations, cancellationToken);
        if (doc is null)
        {
            return Array.Empty<AzureDevOpsAreaPathOptionDto>();
        }

        var list = new List<AzureDevOpsAreaPathOptionDto>();
        CollectAreaPathOptionsFromClassificationNode(doc.RootElement, list);
        return list.OrderBy(o => o.Path, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public async System.Threading.Tasks.Task<string?> ResolveWorkItemSystemAreaPathAsync(
        string accessToken,
        string organization,
        string project,
        int areaNodeId,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        if (areaNodeId <= 0)
        {
            return null;
        }

        var list = await GetProjectAreaPathsAsync(
            accessToken, organization, project, cancellationToken, useBasicAuth);
        var node = list.FirstOrDefault(n => n.Id == areaNodeId);
        if (node is null)
        {
            return null;
        }

        var httpClient = CreateHttpClient(accessToken, useBasicAuth);
        var set = await FetchClassificationAreaPathSetAsync(
            httpClient, organization, project, cancellationToken);

        // Must match a path the Areas tree actually returns. ResolveToCanonicalAreaPath() can
        // prepend the project and produce a value that is *not* in the tree (e.g. wrong root
        // segment) — WIT then rejects with TF401347. Prefer exact membership in the set.
        static string? NormalizeNodePath(string? p) =>
            string.IsNullOrEmpty(p) ? null : NormalizeAdoAreaPath(p).TrimStart('\\');

        var normalized = NormalizeNodePath(node.Path);
        if (string.IsNullOrEmpty(normalized))
        {
            return null;
        }

        if (set.Count > 0)
        {
            var fromSet = set.FirstOrDefault(s => s.Equals(normalized, StringComparison.OrdinalIgnoreCase));
            if (fromSet is not null)
            {
                return fromSet;
            }

            // List may be from a different parse than the set; re-read from the same tree the set uses.
            using var classDoc = await FetchClassificationTreeDocumentAsync(
                httpClient, organization, project, ClassificationTreeAreas, cancellationToken);
            if (classDoc is not null &&
                TryFindClassificationNodeById(classDoc.RootElement, areaNodeId, out var matchEl) &&
                matchEl.TryGetProperty("path", out var pathEl))
            {
                var fromTree = NormalizeNodePath(pathEl.GetString());
                if (!string.IsNullOrEmpty(fromTree))
                {
                    fromSet = set.FirstOrDefault(s => s.Equals(fromTree, StringComparison.OrdinalIgnoreCase));
                    if (fromSet is not null)
                    {
                        return fromSet;
                    }
                }
            }

            _logger.LogWarning(
                "Could not map area node {AreaNodeId} to a System.AreaPath in the project Areas set (node path '{NodePath}'). WIT will reject non-tree paths (TF401347).",
                areaNodeId, node.Path);
            return null;
        }

        // No paths in set (e.g. empty tree or failed load): last resort using legacy resolution.
        return ResolveToCanonicalAreaPath(project, node.Path, set)?.Trim();
    }

    public async System.Threading.Tasks.Task<AzureDevOpsWorkItemsHierarchyDto> GetWorkItemsAsync(
        string accessToken,
        string organization,
        string project,
        string? teamId = null,
        string? areaPathOverride = null,
        int? areaNodeId = null,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false,
        bool includeDescendantAreaPaths = true)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);

        try
        {
            var result = new AzureDevOpsWorkItemsHierarchyDto();

            // When teamId is provided, fetch team's area paths via Team Field Values API and filter WIQL.
            // includeDescendantAreaPaths: true = every path uses [AreaPath] UNDER (work items in that node and all child areas).
            // false = use Team Field "includeChildren" per path: if false for a path, [AreaPath] = that path only; if true, UNDER.
            // areaNodeId: filter by System.AreaId (avoids TF51011 when REST path != valid WIQL System.AreaPath string).
            // areaPathOverride: prefer areaNodeId from UI; legacy string path, uses System.AreaPath UNDER/=.
            string? areaPathFilter = null;
            if (areaNodeId is > 0)
            {
                using var classDoc = await FetchClassificationTreeDocumentAsync(
                    httpClient, organization, project, ClassificationTreeAreas, cancellationToken);
                if (classDoc is not null &&
                    TryFindClassificationNodeById(classDoc.RootElement, areaNodeId.Value, out var matchNode))
                {
                    var ids = new List<int>();
                    if (includeDescendantAreaPaths)
                    {
                        CollectClassificationNodeAndDescendantIds(matchNode, ids);
                    }
                    else if (TryGetClassificationNodeId(matchNode, out var oneId) && oneId > 0)
                    {
                        ids.Add(oneId);
                    }

                    if (ids.Count > 0)
                    {
                        var distinct = ids.Distinct().ToList();
                        areaPathFilter = distinct.Count == 1
                            ? $" AND [System.AreaId] = {distinct[0]}"
                            : $" AND [System.AreaId] IN ({string.Join(", ", distinct)})";
                        _logger.LogInformation(
                            "WIQL using System.AreaId (node {NodeId}, {Count} ids, includeDescendantAreaPaths: {Desc})",
                            areaNodeId, distinct.Count, includeDescendantAreaPaths);
                    }
                }
                else
                {
                    _logger.LogWarning("Area classification node {NodeId} not found, falling back to team/path", areaNodeId);
                }
            }

            if (areaPathFilter is null && !string.IsNullOrWhiteSpace(areaPathOverride))
            {
                var classificationAreaPaths = await FetchClassificationAreaPathSetAsync(
                    httpClient, organization, project, cancellationToken);
                var p = ResolveToCanonicalAreaPath(
                    project, areaPathOverride.Trim(), classificationAreaPaths);
                if (string.IsNullOrEmpty(p) && !string.IsNullOrEmpty(project))
                {
                    var withPrefix = project + "\\" + areaPathOverride.Trim().TrimStart('\\');
                    p = ResolveToCanonicalAreaPath(project, withPrefix, classificationAreaPaths);
                }

                if (!string.IsNullOrEmpty(p))
                {
                    var escaped = p.Replace("'", "''", StringComparison.Ordinal);
                    areaPathFilter = (includeDescendantAreaPaths
                        ? $" AND ([System.AreaPath] UNDER '{escaped}')"
                        : $" AND ([System.AreaPath] = '{escaped}')");
                    _logger.LogInformation("WIQL using explicit area path: {Path}", p);
                }
                else
                {
                    _logger.LogWarning("Area path override could not be resolved, falling back to team: {Raw}", areaPathOverride);
                }
            }

            if (areaPathFilter is null && !string.IsNullOrEmpty(teamId))
            {
                var classificationAreaPaths = await FetchClassificationAreaPathSetAsync(
                    httpClient, organization, project, cancellationToken);
                if (classificationAreaPaths.Count > 0)
                {
                    _logger.LogInformation("Loaded {N} area paths from classification (for team area resolution)", classificationAreaPaths.Count);
                }
                try
                {
                    var teamFieldValuesUrl = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/{AzureDevOpsPathSegment(teamId!, nameof(teamId))}/_apis/work/teamsettings/teamfieldvalues?api-version={AzureDevOpsApiVersion}";
                    var teamFieldResponse = await httpClient.GetAsync(teamFieldValuesUrl, cancellationToken);
                    if (teamFieldResponse.IsSuccessStatusCode)
                    {
                        var teamFieldContent = await teamFieldResponse.Content.ReadAsStringAsync(cancellationToken);
                        var teamFieldDoc = JsonDocument.Parse(teamFieldContent);
                        var root = teamFieldDoc.RootElement;

                        // Team Field Values: { "defaultValue": "Project\\Area", "values": [{ "value": "...", "includeChildren": true|false }] }
                        var pathEntries = new List<(string Path, bool IncludeChildren)>();
                        void AddPath(string? raw, bool includeChildrenFromTeam)
                        {
                            var p = NormalizeAdoAreaPath(raw);
                            if (string.IsNullOrEmpty(p)) return;
                            if (pathEntries.Any(e => e.Path.Equals(p, StringComparison.OrdinalIgnoreCase)))
                                return;
                            pathEntries.Add((p, includeChildrenFromTeam));
                        }

                        if (root.TryGetProperty("defaultValue", out var defaultVal))
                        {
                            var path = defaultVal.GetString();
                            if (!string.IsNullOrEmpty(path))
                            {
                                // Default team area: include descendants unless we're in strict (non-UNDER) mode; treat as true.
                                AddPath(path, true);
                            }
                        }

                        if (root.TryGetProperty("values", out var valuesArr))
                        {
                            foreach (var v in valuesArr.EnumerateArray())
                            {
                                if (!v.TryGetProperty("value", out var valProp))
                                    continue;
                                var path = valProp.GetString();
                                var includeChildren = true;
                                if (v.TryGetProperty("includeChildren", out var incProp) && incProp.ValueKind == JsonValueKind.False)
                                    includeChildren = false;
                                AddPath(path, includeChildren);
                            }
                        }

                        if (pathEntries.Count > 0)
                        {
                            // Map API strings to full System.AreaPath (e.g. Agentic\test team\TEST) so WIQL UNDER matches sub-areas
                            var merged = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
                            foreach (var (rawPath, teamIncludeChildren) in pathEntries)
                            {
                                var p = ResolveToCanonicalAreaPath(project, rawPath, classificationAreaPaths);
                                if (string.IsNullOrEmpty(p)) continue;
                                if (merged.ContainsKey(p))
                                {
                                    if (teamIncludeChildren) merged[p] = true;
                                }
                                else
                                {
                                    merged[p] = teamIncludeChildren;
                                }
                            }

                            if (merged.Count == 0)
                            {
                                _logger.LogWarning("Team {TeamId} had no resolvable area paths after classification mapping", teamId);
                            }
                            var clauses = new List<string>();
                            foreach (var kvp in merged)
                            {
                                var p = kvp.Key;
                                var teamIncludeChildren = kvp.Value;
                                _logger.LogDebug("Team {TeamId} WIQL area filter using path: {Path} (includeChildren from API: {Inc})", teamId, p, teamIncludeChildren);
                                var escaped = p.Replace("'", "''", StringComparison.Ordinal);
                                if (includeDescendantAreaPaths || teamIncludeChildren)
                                {
                                    clauses.Add($"[System.AreaPath] UNDER '{escaped}'");
                                }
                                else
                                {
                                    clauses.Add($"[System.AreaPath] = '{escaped}'");
                                }
                            }

                            if (clauses.Count > 0)
                            {
                                areaPathFilter = " AND (" + string.Join(" OR ", clauses) + ")";
                                _logger.LogInformation(
                                    "Team {TeamId} area paths (includeDescendantAreaPaths={GlobalInc}, resolved: {Details})",
                                    teamId, includeDescendantAreaPaths, string.Join("; ", merged.Select(kvp => $"{kvp.Key} (inc={kvp.Value})")));
                            }
                        }
                        else
                        {
                            _logger.LogWarning("Team {TeamId} has no area paths in team field values", teamId);
                        }
                    }
                    else
                    {
                        _logger.LogWarning("Team Field Values API failed for {TeamId}: {StatusCode}", teamId, teamFieldResponse.StatusCode);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Error fetching team field values for {TeamId}", teamId);
                }
            }

            var areaFilter = areaPathFilter ?? "";

            var wiqlQuery = new
            {
                query = $@"SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.AssignedTo], [System.Parent]
                          FROM WorkItems 
                          WHERE [System.TeamProject] = '{EscapeWiqlStringLiteral(project)}'{areaFilter}
                          AND [System.WorkItemType] IN ('Epic', 'Feature', 'User Story', 'Task', 'Bug', 'Product Backlog Item')
                          ORDER BY [System.WorkItemType], [System.Id]"
            };

            var jsonContent = new StringContent(
                JsonSerializer.Serialize(wiqlQuery),
                Encoding.UTF8,
                "application/json");

            var wiqlUrl = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/wit/wiql?api-version={AzureDevOpsApiVersion}";
            _logger.LogInformation("Fetching work items (team filter: {TeamFilter}, area filter applied: {HasFilter})",
                string.IsNullOrEmpty(teamId) ? "none" : teamId, !string.IsNullOrEmpty(areaFilter));

            var wiqlResponse = await httpClient.PostAsync(
                wiqlUrl,
                jsonContent,
                cancellationToken);

            var responseContent = await wiqlResponse.Content.ReadAsStringAsync(cancellationToken);
            
            // Check for HTML response (authentication failure)
            if (responseContent.TrimStart().StartsWith("<") || responseContent.TrimStart().StartsWith("<!"))
            {
                _logger.LogError("Azure DevOps returned HTML instead of JSON for work items query");
                throw new InvalidOperationException($"Azure DevOps authentication failed for organization '{organization}'. Please use a PAT with work item read permissions.");
            }

            if (!wiqlResponse.IsSuccessStatusCode)
            {
                _logger.LogError("Azure DevOps WIQL query failed: {StatusCode} - {Content}", wiqlResponse.StatusCode, responseContent);
                throw new HttpRequestException($"Azure DevOps API returned {wiqlResponse.StatusCode}: {responseContent}");
            }

            var wiqlResult = JsonDocument.Parse(responseContent);
            
            // Get work item IDs from WIQL result
            var workItemIds = new List<int>();
            if (wiqlResult.RootElement.TryGetProperty("workItems", out var workItemsArray))
            {
                foreach (var item in workItemsArray.EnumerateArray())
                {
                    if (item.TryGetProperty("id", out var idProp))
                    {
                        workItemIds.Add(idProp.GetInt32());
                    }
                }
            }

            _logger.LogInformation("Found {Count} work items in project {Project}", workItemIds.Count, project);

            if (workItemIds.Count == 0)
            {
                return result;
            }

            // Fetch work item details in batches (Azure DevOps limits to 200 per request)
            var allWorkItems = new List<AzureDevOpsWorkItemDto>();
            const int batchSize = 200;
            
            for (int i = 0; i < workItemIds.Count; i += batchSize)
            {
                var batch = workItemIds.Skip(i).Take(batchSize).ToList();
                var idsParam = string.Join(",", batch);
                
                var detailsResponse = await httpClient.GetAsync(
                    $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/wit/workitems?ids={idsParam}&$expand=relations&api-version={AzureDevOpsApiVersion}",
                    cancellationToken);

                if (!detailsResponse.IsSuccessStatusCode)
                {
                    _logger.LogWarning("Failed to fetch work item details batch: {StatusCode}", detailsResponse.StatusCode);
                    continue;
                }

                var detailsContent = await detailsResponse.Content.ReadAsStringAsync(cancellationToken);
                var detailsResult = JsonDocument.Parse(detailsContent);

                if (detailsResult.RootElement.TryGetProperty("value", out var valueArray))
                {
                    foreach (var item in valueArray.EnumerateArray())
                    {
                        var workItem = ParseWorkItem(item, organization, project);
                        if (workItem != null)
                        {
                            allWorkItems.Add(workItem);
                        }
                    }
                }
            }

            // Categorize work items by type
            foreach (var item in allWorkItems)
            {
                switch (item.WorkItemType.ToLowerInvariant())
                {
                    case "epic":
                        result.Epics.Add(item);
                        break;
                    case "feature":
                        result.Features.Add(item);
                        break;
                    case "user story":
                    case "product backlog item":
                        result.UserStories.Add(item);
                        break;
                    case "task":
                        result.Tasks.Add(item);
                        break;
                    case "bug":
                        result.Bugs.Add(item);
                        break;
                }
            }

            _logger.LogInformation(
                "Categorized work items - Epics: {Epics}, Features: {Features}, User Stories: {Stories}, Tasks: {Tasks}, Bugs: {Bugs}",
                result.Epics.Count, result.Features.Count, result.UserStories.Count, result.Tasks.Count, result.Bugs.Count);

            return result;
        }
        catch (InvalidOperationException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching work items from Azure DevOps for {Organization}/{Project}", organization, project);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<IReadOnlyList<AzureDevOpsWorkItemStateDto>> GetWorkItemTypeStatesAsync(
        string accessToken,
        string organization,
        string project,
        string workItemType,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);
        var encodedType = Uri.EscapeDataString(workItemType);
        var url = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/wit/workitemtypes/{encodedType}/states?api-version=7.1";

        var response = await httpClient.GetAsync(url, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("Failed to fetch work item type states for {Type}: {StatusCode}", workItemType, response.StatusCode);
            return Array.Empty<AzureDevOpsWorkItemStateDto>();
        }

        var content = await response.Content.ReadAsStringAsync(cancellationToken);
        var doc = JsonDocument.Parse(content);
        var result = new List<AzureDevOpsWorkItemStateDto>();

        if (doc.RootElement.TryGetProperty("value", out var valueArray))
        {
            foreach (var item in valueArray.EnumerateArray())
            {
                var name = item.TryGetProperty("name", out var n) ? n.GetString() : null;
                var category = item.TryGetProperty("category", out var c) ? c.GetString() : null;
                if (!string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(category))
                    result.Add(new AzureDevOpsWorkItemStateDto { Name = name, Category = category });
            }
        }

        return result;
    }

    public async System.Threading.Tasks.Task<IReadOnlyDictionary<int, string>> GetWorkItemTypesByIdsAsync(
        string accessToken,
        string organization,
        string project,
        IReadOnlyList<int> workItemIds,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        if (workItemIds == null || workItemIds.Count == 0)
            return new Dictionary<int, string>();

        var httpClient = CreateHttpClient(accessToken, useBasicAuth);
        var idsParam = string.Join(",", workItemIds);
        var url = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/wit/workitems?ids={idsParam}&fields=System.WorkItemType&api-version={AzureDevOpsApiVersion}";

        var response = await httpClient.GetAsync(url, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("Failed to fetch work item types: {StatusCode}", response.StatusCode);
            return new Dictionary<int, string>();
        }

        var content = await response.Content.ReadAsStringAsync(cancellationToken);
        var doc = JsonDocument.Parse(content);
        var result = new Dictionary<int, string>();

        if (doc.RootElement.TryGetProperty("value", out var valueArray))
        {
            foreach (var item in valueArray.EnumerateArray())
            {
                var id = item.TryGetProperty("id", out var idProp) ? idProp.GetInt32() : 0;
                var workItemType = "Unknown";
                if (item.TryGetProperty("fields", out var fields) && fields.TryGetProperty("System.WorkItemType", out var t))
                    workItemType = t.GetString() ?? "Unknown";
                if (id > 0)
                    result[id] = workItemType;
            }
        }

        return result;
    }

    public async System.Threading.Tasks.Task<IReadOnlyList<AzureDevOpsWorkItemDto>> GetWorkItemsByIdsAsync(
        string accessToken,
        string organization,
        string project,
        IReadOnlyList<int> workItemIds,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        if (workItemIds == null || workItemIds.Count == 0)
            return Array.Empty<AzureDevOpsWorkItemDto>();

        var httpClient = CreateHttpClient(accessToken, useBasicAuth);
        const int chunkSize = 200;
        var result = new List<AzureDevOpsWorkItemDto>();

        for (var offset = 0; offset < workItemIds.Count; offset += chunkSize)
        {
            var chunk = workItemIds.Skip(offset).Take(chunkSize).Distinct().ToList();
            if (chunk.Count == 0) continue;
            var idsParam = string.Join(",", chunk);
            var url =
                $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/wit/workitems?ids={idsParam}&api-version={AzureDevOpsApiVersion}";

            var response = await httpClient.GetAsync(url, cancellationToken);
            var content = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode || content.TrimStart().StartsWith("<"))
            {
                _logger.LogWarning("Get work items by ids failed {Status}: {Body}", response.StatusCode, content);
                continue;
            }

            var doc = JsonDocument.Parse(content);
            if (doc.RootElement.TryGetProperty("value", out var valueArray))
            {
                foreach (var item in valueArray.EnumerateArray())
                {
                    var dto = ParseWorkItem(item, organization, project);
                    if (dto != null)
                        result.Add(dto);
                }
            }
        }

        return result;
    }

    public async System.Threading.Tasks.Task UpdateWorkItemAsync(
        string accessToken,
        string organization,
        string project,
        int workItemId,
        IReadOnlyList<AzureDevOpsWorkItemPatchOperation> patches,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        if (patches == null || patches.Count == 0)
            return;

        var httpClient = CreateHttpClient(accessToken, useBasicAuth);
        var url = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/wit/workitems/{workItemId}?api-version={AzureDevOpsApiVersion}";

        var patchArray = patches.Select(p => new Dictionary<string, object?>
        {
            ["op"] = p.Op,
            ["path"] = p.Path,
            ["value"] = p.Value
        }).ToList();

        var json = JsonSerializer.Serialize(patchArray);
        var content = new StringContent(json, Encoding.UTF8, "application/json-patch+json");

        var response = await httpClient.PatchAsync(url, content, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var errBody = await response.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogError("Azure DevOps update work item {WorkItemId} failed: {StatusCode} - {Content}", workItemId, response.StatusCode, errBody);
            throw new HttpRequestException($"Azure DevOps API returned {response.StatusCode}: {errBody}");
        }

        _logger.LogInformation("Updated Azure DevOps work item {WorkItemId}", workItemId);
    }

    public async System.Threading.Tasks.Task<int> CreateWorkItemAsync(
        string accessToken,
        string organization,
        string project,
        string workItemTypeName,
        IReadOnlyList<AzureDevOpsWorkItemPatchOperation> fieldPatches,
        int? parentWorkItemId,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(workItemTypeName);
        if (fieldPatches == null || fieldPatches.Count == 0)
            throw new ArgumentException("At least one patch is required", nameof(fieldPatches));

        var httpClient = CreateHttpClient(accessToken, useBasicAuth);
        var typeSegment = "$" + Uri.EscapeDataString(workItemTypeName);
        var url =
            $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/wit/workitems/{typeSegment}?api-version={AzureDevOpsApiVersion}";

        var patchArray = fieldPatches.Select(p => new Dictionary<string, object?>
        {
            ["op"] = p.Op,
            ["path"] = p.Path,
            ["value"] = p.Value
        }).ToList();

        if (parentWorkItemId.HasValue)
        {
            var parentUrl =
                $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/wit/workitems/{parentWorkItemId.Value}";
            patchArray.Add(new Dictionary<string, object?>
            {
                ["op"] = "add",
                ["path"] = "/relations/-",
                ["value"] = new Dictionary<string, object?>
                {
                    ["rel"] = "System.LinkTypes.Hierarchy-Reverse",
                    ["url"] = parentUrl
                }
            });
        }

        var json = JsonSerializer.Serialize(patchArray);
        var content = new StringContent(json, Encoding.UTF8, "application/json-patch+json");

        var response = await httpClient.PostAsync(url, content, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            _logger.LogError("Azure DevOps create work item failed: {StatusCode} - {Content}", response.StatusCode, body);
            throw new HttpRequestException($"Azure DevOps API returned {response.StatusCode}: {body}");
        }

        var doc = JsonDocument.Parse(body);
        var id = doc.RootElement.GetProperty("id").GetInt32();
        _logger.LogInformation("Created Azure DevOps work item {WorkItemId} type {Type}", id, workItemTypeName);
        return id;
    }

    public async System.Threading.Tasks.Task<AzureDevOpsTeamSettingsDto?> GetTeamSettingsAsync(
        string accessToken,
        string organization,
        string project,
        string teamId,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);
        var url =
            $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/{AzureDevOpsPathSegment(teamId, nameof(teamId))}/_apis/work/teamsettings?api-version={AzureDevOpsApiVersion}";

        var response = await httpClient.GetAsync(url, cancellationToken);
        var content = await response.Content.ReadAsStringAsync(cancellationToken);
        if (content.TrimStart().StartsWith("<"))
        {
            _logger.LogError("Azure DevOps team settings returned HTML");
            throw new InvalidOperationException("Azure DevOps authentication failed when reading team settings.");
        }

        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("Team settings failed {Status}: {Body}", response.StatusCode, content);
            return null;
        }

        var doc = JsonDocument.Parse(content);
        var root = doc.RootElement;
        // REST 7.x TeamSettings often omits teamField; default area lives on teamfieldvalues (same as boards / WIQL).
        string? area = null;
        if (root.TryGetProperty("teamField", out var tf) && tf.TryGetProperty("defaultValue", out var dv))
            area = NonEmptyPath(dv.GetString());

        string? teamIterationPathRaw = null;
        if (root.TryGetProperty("backlogIteration", out var bi) && bi.ValueKind == JsonValueKind.Object &&
            bi.TryGetProperty("path", out var bip))
            teamIterationPathRaw = NonEmptyPath(bip.GetString());
        if (string.IsNullOrEmpty(teamIterationPathRaw) && root.TryGetProperty("defaultIteration", out var di) && di.ValueKind == JsonValueKind.Object &&
            di.TryGetProperty("path", out var dip))
            teamIterationPathRaw = NonEmptyPath(dip.GetString());

        if (string.IsNullOrEmpty(area))
        {
            var teamFieldValuesUrl =
                $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/{AzureDevOpsPathSegment(teamId, nameof(teamId))}/_apis/work/teamsettings/teamfieldvalues?api-version={AzureDevOpsApiVersion}";
            var tfvResponse = await httpClient.GetAsync(teamFieldValuesUrl, cancellationToken);
            var tfvContent = await tfvResponse.Content.ReadAsStringAsync(cancellationToken);
            if (tfvResponse.IsSuccessStatusCode && !tfvContent.TrimStart().StartsWith("<"))
            {
                try
                {
                    var tfvDoc = JsonDocument.Parse(tfvContent);
                    var tfvRoot = tfvDoc.RootElement;
                    if (tfvRoot.TryGetProperty("defaultValue", out var defVal))
                        area = NonEmptyPath(defVal.GetString());
                    if (string.IsNullOrEmpty(area) && tfvRoot.TryGetProperty("values", out var valuesArr))
                    {
                        foreach (var v in valuesArr.EnumerateArray())
                        {
                            if (!v.TryGetProperty("value", out var valProp)) continue;
                            area = NonEmptyPath(valProp.GetString());
                            if (!string.IsNullOrEmpty(area)) break;
                        }
                    }
                }
                catch (JsonException ex)
                {
                    _logger.LogWarning(ex, "Could not parse teamfieldvalues for team {TeamId}", teamId);
                }
            }
            else
                _logger.LogWarning("Team field values failed {Status} for team {TeamId}: {Body}", tfvResponse.StatusCode, teamId, tfvContent);
        }

        // System.IterationPath must match a node in the project Iterations tree; team settings can return a path
        // that WIT rejects (TF401347 Invalid tree name). Resolve against classification, then fall back to a safe default.
        var iterationPathSet = await FetchClassificationIterationPathSetAsync(
            httpClient, organization, project, cancellationToken);
        var backlogIterationPath = ResolveTeamIterationForWorkItems(
            project, teamIterationPathRaw, iterationPathSet);

        return new AzureDevOpsTeamSettingsDto
        {
            DefaultAreaPath = area,
            BacklogIterationPath = backlogIterationPath
        };
    }

    private static string? PickDefaultIterationPathFromClassification(string project, IReadOnlyCollection<string> iterationPaths)
    {
        if (iterationPaths.Count == 0) return null;
        var p = project.Trim();
        var atProjectRoot = iterationPaths
            .FirstOrDefault(s => s.Equals(p, StringComparison.OrdinalIgnoreCase));
        if (atProjectRoot is not null)
        {
            return atProjectRoot;
        }

        return iterationPaths
            .OrderBy(s => s.Length)
            .ThenBy(s => s, StringComparer.OrdinalIgnoreCase)
            .First();
    }

    /// <summary>Maps team backlog iteration to a path that exists in the Iterations tree (WIT otherwise returns TF401347).</summary>
    private string? ResolveTeamIterationForWorkItems(
        string project,
        string? teamIterationPathRaw,
        HashSet<string> iterationPathSet)
    {
        if (iterationPathSet.Count == 0)
        {
            if (!string.IsNullOrWhiteSpace(teamIterationPathRaw))
            {
                _logger.LogWarning(
                    "Iterations classification is empty; omitting System.IterationPath to avoid invalid tree (team had: {Path})",
                    teamIterationPathRaw);
            }

            return null;
        }

        if (!string.IsNullOrWhiteSpace(teamIterationPathRaw))
        {
            var normalized = NormalizeAdoAreaPath(teamIterationPathRaw).TrimStart('\\');
            if (string.IsNullOrEmpty(normalized))
            {
                return PickDefaultIterationPathFromClassification(project, iterationPathSet);
            }

            var resolved = ResolveToCanonicalAreaPath(project, normalized, iterationPathSet);
            if (iterationPathSet.Any(ip => ip.Equals(resolved, StringComparison.OrdinalIgnoreCase)))
            {
                return iterationPathSet.First(ip => ip.Equals(resolved, StringComparison.OrdinalIgnoreCase));
            }

            if (iterationPathSet.Any(ip => ip.Equals(normalized, StringComparison.OrdinalIgnoreCase)))
            {
                return iterationPathSet.First(ip => ip.Equals(normalized, StringComparison.OrdinalIgnoreCase));
            }

            _logger.LogWarning(
                "Team iteration path {Path} is not in project Iteration classification; using default (TF401347 prevention)",
                teamIterationPathRaw);
        }

        return PickDefaultIterationPathFromClassification(project, iterationPathSet);
    }

    /// <summary>Azure often returns whitespace/empty for unset paths; treat as missing.</summary>
    private static string? NonEmptyPath(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public async System.Threading.Tasks.Task<AzureDevOpsBacklogWorkItemTypesDto> ResolveBacklogWorkItemTypesAsync(
        string accessToken,
        string organization,
        string project,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);
        var url =
            $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/wit/workitemtypes?api-version={AzureDevOpsApiVersion}";

        var response = await httpClient.GetAsync(url, cancellationToken);
        var content = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode || content.TrimStart().StartsWith("<"))
        {
            _logger.LogWarning("Work item types list failed");
            return new AzureDevOpsBacklogWorkItemTypesDto();
        }

        var doc = JsonDocument.Parse(content);
        var names = new List<string>();
        if (doc.RootElement.TryGetProperty("value", out var arr))
        {
            foreach (var el in arr.EnumerateArray())
            {
                if (el.TryGetProperty("name", out var n))
                    names.Add(n.GetString() ?? "");
            }
        }

        string? Pick(params string[] candidates)
        {
            foreach (var c in candidates)
            {
                var m = names.Find(x => x.Equals(c, StringComparison.OrdinalIgnoreCase));
                if (m != null) return m;
            }
            return null;
        }

        return new AzureDevOpsBacklogWorkItemTypesDto
        {
            EpicTypeName = Pick("Epic"),
            FeatureTypeName = Pick("Feature"),
            StoryTypeName = Pick("User Story", "Product Backlog Item")
        };
    }

    private AzureDevOpsWorkItemDto? ParseWorkItem(JsonElement item, string organization, string project)
    {
        try
        {
            var id = item.GetProperty("id").GetInt32();
            var fields = item.GetProperty("fields");

            var workItemType = fields.TryGetProperty("System.WorkItemType", out var typeProp) 
                ? typeProp.GetString() ?? "Unknown" 
                : "Unknown";

            var title = fields.TryGetProperty("System.Title", out var titleProp) 
                ? titleProp.GetString() ?? "Untitled" 
                : "Untitled";

            var state = fields.TryGetProperty("System.State", out var stateProp) 
                ? stateProp.GetString() ?? "New" 
                : "New";

            var dto = new AzureDevOpsWorkItemDto
            {
                Id = id,
                Title = title,
                WorkItemType = workItemType,
                State = state,
                Url = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_workitems/edit/{id}"
            };

            // Optional fields
            if (fields.TryGetProperty("System.Description", out var descProp))
            {
                dto.Description = descProp.GetString();
            }

            if (fields.TryGetProperty("System.AssignedTo", out var assignedProp) && assignedProp.ValueKind == JsonValueKind.Object)
            {
                dto.AssignedTo = assignedProp.TryGetProperty("displayName", out var displayName) 
                    ? displayName.GetString() 
                    : null;
            }

            if (fields.TryGetProperty("Microsoft.VSTS.Common.Priority", out var priorityProp))
            {
                dto.Priority = priorityProp.GetInt32();
            }

            if (fields.TryGetProperty("Microsoft.VSTS.Scheduling.StoryPoints", out var storyPointsProp))
            {
                dto.StoryPoints = storyPointsProp.GetDouble();
            }

            if (fields.TryGetProperty("Microsoft.VSTS.Common.AcceptanceCriteria", out var acProp))
            {
                dto.AcceptanceCriteria = acProp.GetString();
            }

            if (fields.TryGetProperty("System.Parent", out var parentProp))
            {
                dto.ParentId = parentProp.GetInt32();
            }

            if (fields.TryGetProperty("System.AreaPath", out var areaProp))
            {
                dto.AreaPath = areaProp.GetString();
            }

            if (fields.TryGetProperty("System.IterationPath", out var iterProp))
            {
                dto.IterationPath = iterProp.GetString();
            }

            if (fields.TryGetProperty("System.CreatedDate", out var createdProp))
            {
                dto.CreatedDate = DateTime.Parse(createdProp.GetString() ?? DateTime.UtcNow.ToString());
            }

            if (fields.TryGetProperty("System.ChangedDate", out var changedProp))
            {
                dto.ChangedDate = DateTime.Parse(changedProp.GetString() ?? DateTime.UtcNow.ToString());
            }

            // Get child IDs from relations
            if (item.TryGetProperty("relations", out var relations) && relations.ValueKind == JsonValueKind.Array)
            {
                foreach (var relation in relations.EnumerateArray())
                {
                    if (relation.TryGetProperty("rel", out var relType) && 
                        relType.GetString() == "System.LinkTypes.Hierarchy-Forward" &&
                        relation.TryGetProperty("url", out var urlProp))
                    {
                        // URL format: https://dev.azure.com/{org}/_apis/wit/workItems/{id}
                        var url = urlProp.GetString();
                        if (url != null)
                        {
                            var lastSlash = url.LastIndexOf('/');
                            if (lastSlash >= 0 && int.TryParse(url.Substring(lastSlash + 1), out var childId))
                            {
                                dto.ChildIds.Add(childId);
                            }
                        }
                    }
                }
            }

            return dto;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to parse work item");
            return null;
        }
    }

    private HttpClient CreateHttpClient(string accessToken, bool useBasicAuth = false)
    {
        var httpClient = _httpClientFactory.CreateClient("AzureDevOps");
        
        if (useBasicAuth)
        {
            // PAT authentication uses Basic auth with empty username
            httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", accessToken);
        }
        else
        {
            // OAuth uses Bearer token
            httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        }
        
        httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return httpClient;
    }

    public async System.Threading.Tasks.Task<RepositoryTreeDto> GetRepositoryTreeAsync(
        string accessToken,
        string organization,
        string project,
        string repositoryId,
        string? path = null,
        string? branch = null,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);

        try
        {
            EnsureSafeGitPath(path, nameof(path));
            // Get default branch if not specified
            if (string.IsNullOrEmpty(branch))
            {
                var reposResponse = await httpClient.GetAsync(
                    $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/git/repositories/{AzureDevOpsPathSegment(repositoryId, nameof(repositoryId))}?api-version={AzureDevOpsApiVersion}",
                    cancellationToken);
                
                if (reposResponse.IsSuccessStatusCode)
                {
                    var repoContent = await reposResponse.Content.ReadAsStringAsync(cancellationToken);
                    var repo = JsonDocument.Parse(repoContent);
                    if (repo.RootElement.TryGetProperty("defaultBranch", out var defaultBranch))
                    {
                        branch = defaultBranch.GetString()?.Replace("refs/heads/", "") ?? "main";
                    }
                }
                branch ??= "main";
            }

            var result = new RepositoryTreeDto
            {
                Path = path ?? "",
                Branch = branch
            };

            // Build the API URL for items
            var scopePath = string.IsNullOrEmpty(path) ? "/" : $"/{path}";
            var url = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/git/repositories/{AzureDevOpsPathSegment(repositoryId, nameof(repositoryId))}/items?scopePath={Uri.EscapeDataString(scopePath)}&recursionLevel=OneLevel&versionDescriptor.version={Uri.EscapeDataString(branch)}&versionDescriptor.versionType=branch&api-version={AzureDevOpsApiVersion}";

            var response = await httpClient.GetAsync(url, cancellationToken);

            var responseContent = await response.Content.ReadAsStringAsync(cancellationToken);
            
            if (responseContent.TrimStart().StartsWith("<"))
            {
                throw new InvalidOperationException($"Azure DevOps authentication failed. Please use a PAT with code read permissions.");
            }

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Azure DevOps items API failed: {StatusCode} - {Content}", response.StatusCode, responseContent);
                throw new HttpRequestException($"Azure DevOps API returned {response.StatusCode}");
            }

            var items = JsonDocument.Parse(responseContent);

            if (items.RootElement.TryGetProperty("value", out var valueArray))
            {
                var sortedItems = valueArray.EnumerateArray()
                    .Select(item => new
                    {
                        IsFolder = item.TryGetProperty("isFolder", out var f) && f.GetBoolean(),
                        Path = item.TryGetProperty("path", out var p) ? p.GetString() ?? "" : "",
                        Item = item
                    })
                    .Where(x => x.Path != scopePath) // Exclude the directory itself
                    .OrderBy(x => x.IsFolder ? 0 : 1)
                    .ThenBy(x => System.IO.Path.GetFileName(x.Path), StringComparer.OrdinalIgnoreCase);

                foreach (var sortedItem in sortedItems)
                {
                    var item = sortedItem.Item;
                    var itemPath = sortedItem.Path.TrimStart('/');
                    var itemName = System.IO.Path.GetFileName(itemPath);

                    result.Items.Add(new RepositoryTreeItemDto
                    {
                        Name = itemName,
                        Path = itemPath,
                        Type = sortedItem.IsFolder ? "dir" : "file",
                        Size = item.TryGetProperty("size", out var size) ? size.GetInt64() : null,
                        Sha = item.TryGetProperty("objectId", out var sha) ? sha.GetString() : null,
                        Url = item.TryGetProperty("url", out var itemUrl) ? itemUrl.GetString() : null
                    });

                    // Check for README
                    if (!sortedItem.IsFolder && itemName.StartsWith("README", StringComparison.OrdinalIgnoreCase))
                    {
                        try
                        {
                            var readmeResult = await GetFileContentAsync(accessToken, organization, project, repositoryId, itemPath, branch, cancellationToken, useBasicAuth);
                            result.Readme = readmeResult.Content;
                        }
                        catch
                        {
                            // Ignore README fetch errors
                        }
                    }
                }
            }

            _logger.LogInformation("Fetched {Count} items from {Organization}/{Project}/{Repo}/{Path} on branch {Branch}",
                result.Items.Count, organization, project, repositoryId, path ?? "root", branch);

            return result;
        }
        catch (InvalidOperationException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching repository tree for {Organization}/{Project}/{Repo}/{Path}", organization, project, repositoryId, path);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<RepositoryFileContentDto> GetFileContentAsync(
        string accessToken,
        string organization,
        string project,
        string repositoryId,
        string path,
        string? branch = null,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);

        try
        {
            EnsureSafeGitPath(path, nameof(path));
            branch ??= "main";
            var filePath = path.StartsWith("/") ? path : $"/{path}";
            
            var url = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/git/repositories/{AzureDevOpsPathSegment(repositoryId, nameof(repositoryId))}/items?path={Uri.EscapeDataString(filePath)}&versionDescriptor.version={Uri.EscapeDataString(branch)}&versionDescriptor.versionType=branch&includeContent=true&api-version={AzureDevOpsApiVersion}";

            var response = await httpClient.GetAsync(url, cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                throw new FileNotFoundException($"File not found: {path}");
            }

            var content = await response.Content.ReadAsStringAsync(cancellationToken);
            var fileName = System.IO.Path.GetFileName(path);
            var isBinary = IsBinaryFile(fileName);
            var language = DetectLanguage(fileName);

            // Check if response is JSON (metadata) or raw content
            string fileContent;
            long fileSize = 0;
            string? sha = null;

            if (content.TrimStart().StartsWith("{"))
            {
                var json = JsonDocument.Parse(content);
                fileContent = json.RootElement.TryGetProperty("content", out var c) ? c.GetString() ?? "" : "";
                fileSize = json.RootElement.TryGetProperty("size", out var s) ? s.GetInt64() : 0;
                sha = json.RootElement.TryGetProperty("objectId", out var o) ? o.GetString() : null;
            }
            else
            {
                fileContent = content;
                fileSize = content.Length;
            }

            return new RepositoryFileContentDto
            {
                Name = fileName,
                Path = path,
                Content = isBinary ? "[Binary file - cannot display]" : fileContent,
                Encoding = "utf-8",
                Size = fileSize,
                Sha = sha,
                Language = language,
                IsBinary = isBinary,
                IsTruncated = fileSize > 1_000_000
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching file content for {Organization}/{Project}/{Repo}/{Path}", organization, project, repositoryId, path);
            throw;
        }
    }

    public async System.Threading.Tasks.Task<IEnumerable<RepositoryBranchDto>> GetBranchesAsync(
        string accessToken,
        string organization,
        string project,
        string repositoryId,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);

        try
        {
            // Get repository to find default branch
            var repoResponse = await httpClient.GetAsync(
                $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/git/repositories/{AzureDevOpsPathSegment(repositoryId, nameof(repositoryId))}?api-version={AzureDevOpsApiVersion}",
                cancellationToken);
            
            string? defaultBranch = null;
            if (repoResponse.IsSuccessStatusCode)
            {
                var repoContent = await repoResponse.Content.ReadAsStringAsync(cancellationToken);
                var repo = JsonDocument.Parse(repoContent);
                if (repo.RootElement.TryGetProperty("defaultBranch", out var db))
                {
                    defaultBranch = db.GetString()?.Replace("refs/heads/", "");
                }
            }

            // Get all branches
            var response = await httpClient.GetAsync(
                $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/git/repositories/{AzureDevOpsPathSegment(repositoryId, nameof(repositoryId))}/refs?filter=heads/&api-version={AzureDevOpsApiVersion}",
                cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                throw new HttpRequestException($"Failed to fetch branches: {response.StatusCode}");
            }

            var content = await response.Content.ReadAsStringAsync(cancellationToken);
            var branches = JsonDocument.Parse(content);

            var result = new List<RepositoryBranchDto>();
            if (branches.RootElement.TryGetProperty("value", out var valueArray))
            {
                foreach (var branch in valueArray.EnumerateArray())
                {
                    var name = branch.TryGetProperty("name", out var n) ? n.GetString()?.Replace("refs/heads/", "") ?? "" : "";
                    var sha = branch.TryGetProperty("objectId", out var s) ? s.GetString() ?? "" : "";

                    result.Add(new RepositoryBranchDto
                    {
                        Name = name,
                        Sha = sha,
                        IsDefault = name == defaultBranch,
                        IsProtected = false // Azure DevOps branch policies would need separate API call
                    });
                }
            }

            return result.OrderByDescending(b => b.IsDefault).ThenBy(b => b.Name);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching branches for {Organization}/{Project}/{Repo}", organization, project, repositoryId);
            throw;
        }
    }

    private bool IsBinaryFile(string fileName)
    {
        var binaryExtensions = new[] { 
            ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp",
            ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
            ".zip", ".tar", ".gz", ".rar", ".7z",
            ".exe", ".dll", ".so", ".dylib",
            ".woff", ".woff2", ".ttf", ".eot",
            ".mp3", ".mp4", ".avi", ".mov", ".wav",
            ".sqlite", ".db"
        };

        var ext = System.IO.Path.GetExtension(fileName).ToLowerInvariant();
        return binaryExtensions.Contains(ext);
    }

    private string? DetectLanguage(string fileName)
    {
        var ext = System.IO.Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".cs" => "csharp",
            ".ts" => "typescript",
            ".tsx" => "typescript",
            ".js" => "javascript",
            ".jsx" => "javascript",
            ".py" => "python",
            ".java" => "java",
            ".go" => "go",
            ".rs" => "rust",
            ".rb" => "ruby",
            ".php" => "php",
            ".swift" => "swift",
            ".kt" => "kotlin",
            ".scala" => "scala",
            ".c" => "c",
            ".cpp" or ".cc" or ".cxx" => "cpp",
            ".h" or ".hpp" => "cpp",
            ".html" or ".htm" => "html",
            ".css" => "css",
            ".scss" or ".sass" => "scss",
            ".less" => "less",
            ".json" => "json",
            ".xml" => "xml",
            ".yaml" or ".yml" => "yaml",
            ".md" or ".markdown" => "markdown",
            ".sql" => "sql",
            ".sh" or ".bash" => "bash",
            ".ps1" => "powershell",
            ".dockerfile" => "dockerfile",
            ".graphql" or ".gql" => "graphql",
            ".proto" => "protobuf",
            ".vue" => "vue",
            ".svelte" => "svelte",
            _ when fileName.ToLowerInvariant() == "dockerfile" => "dockerfile",
            _ when fileName.ToLowerInvariant() == "makefile" => "makefile",
            _ when fileName.ToLowerInvariant().EndsWith(".csproj") => "xml",
            _ when fileName.ToLowerInvariant().EndsWith(".sln") => "text",
            _ => null
        };
    }

    public async System.Threading.Tasks.Task<IEnumerable<PullRequestDto>> GetPullRequestsAsync(
        string accessToken,
        string organization,
        string project,
        string repositoryId,
        string? status = "all",
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);

        try
        {
            // Build query parameters
            var statusFilter = status?.ToLowerInvariant() switch
            {
                "open" => "active",
                "closed" => "completed",
                "merged" => "completed",
                _ => "all"
            };

            var url = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/git/repositories/{AzureDevOpsPathSegment(repositoryId, nameof(repositoryId))}/pullrequests?searchCriteria.status={Uri.EscapeDataString(statusFilter)}&api-version={AzureDevOpsApiVersion}";

            var response = await httpClient.GetAsync(url, cancellationToken);
            var content = await response.Content.ReadAsStringAsync(cancellationToken);

            if (content.TrimStart().StartsWith("<"))
            {
                throw new InvalidOperationException("Azure DevOps authentication failed. Please use a valid token.");
            }

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Azure DevOps PR API failed: {StatusCode} - {Content}", response.StatusCode, content);
                throw new HttpRequestException($"Azure DevOps API returned {response.StatusCode}");
            }

            using var prResponse = JsonDocument.Parse(content);
            var result = new List<PullRequestDto>();
            var enrichmentRows = new List<(PullRequestDto Dto, JsonElement Pr)>();

            if (prResponse.RootElement.TryGetProperty("value", out var valueArray))
            {
                foreach (var pr in valueArray.EnumerateArray())
                {
                    var prId = pr.GetProperty("pullRequestId").GetInt32();
                    var prStatus = pr.TryGetProperty("status", out var s) ? s.GetString() ?? "unknown" : "unknown";
                    
                    // Map Azure DevOps status to our standard status
                    var mappedState = prStatus.ToLowerInvariant() switch
                    {
                        "active" => "open",
                        "completed" => pr.TryGetProperty("mergeStatus", out var ms) && ms.GetString() == "succeeded" ? "merged" : "closed",
                        "abandoned" => "closed",
                        _ => prStatus
                    };

                    var createdBy = pr.TryGetProperty("createdBy", out var creator) ? creator : default;
                    var sourceBranch = pr.TryGetProperty("sourceRefName", out var src) ? src.GetString()?.Replace("refs/heads/", "") ?? "unknown" : "unknown";
                    var targetBranch = pr.TryGetProperty("targetRefName", out var tgt) ? tgt.GetString()?.Replace("refs/heads/", "") ?? "unknown" : "unknown";

                    var prDto = new PullRequestDto
                    {
                        Number = prId,
                        Title = pr.TryGetProperty("title", out var title) ? title.GetString() ?? $"PR #{prId}" : $"PR #{prId}",
                        Description = pr.TryGetProperty("description", out var desc) ? desc.GetString() : null,
                        State = mappedState,
                        SourceBranch = sourceBranch,
                        TargetBranch = targetBranch,
                        Author = createdBy.ValueKind != JsonValueKind.Undefined && createdBy.TryGetProperty("displayName", out var authorName) 
                            ? authorName.GetString() ?? "unknown" 
                            : "unknown",
                        AuthorAvatarUrl = createdBy.ValueKind != JsonValueKind.Undefined && createdBy.TryGetProperty("imageUrl", out var avatarUrl) 
                            ? avatarUrl.GetString() 
                            : null,
                        Url = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_git/{AzureDevOpsPathSegment(repositoryId, nameof(repositoryId))}/pullrequest/{prId}",
                        CreatedAt = pr.TryGetProperty("creationDate", out var created) 
                            ? DateTime.Parse(created.GetString() ?? DateTime.UtcNow.ToString()) 
                            : DateTime.UtcNow,
                        ClosedAt = pr.TryGetProperty("closedDate", out var closed) && closed.ValueKind != JsonValueKind.Null
                            ? DateTime.Parse(closed.GetString() ?? DateTime.UtcNow.ToString())
                            : null,
                        IsMerged = mappedState == "merged",
                        IsDraft = pr.TryGetProperty("isDraft", out var draft) && draft.GetBoolean(),
                        Labels = new List<string>(),
                        Reviewers = new List<string>()
                    };

                    // Get reviewers
                    if (pr.TryGetProperty("reviewers", out var reviewers))
                    {
                        foreach (var reviewer in reviewers.EnumerateArray())
                        {
                            if (reviewer.TryGetProperty("displayName", out var reviewerName))
                            {
                                prDto.Reviewers.Add(reviewerName.GetString() ?? "");
                            }
                        }
                    }

                    enrichmentRows.Add((prDto, pr));
                    result.Add(prDto);
                }
            }

            if (enrichmentRows.Count > 0)
            {
                const int enrichMax = 20;
                var enrichTasks = enrichmentRows
                    .Take(enrichMax)
                    .Select(r => TryEnrichAzureDevOpsPullRequestStatsAsync(
                        httpClient,
                        organization,
                        project,
                        repositoryId,
                        r.Dto,
                        r.Pr,
                        cancellationToken))
                    .ToArray();
                await System.Threading.Tasks.Task.WhenAll(enrichTasks);
            }

            _logger.LogInformation("Found {Count} pull requests in {Organization}/{Project}/{Repo}", 
                result.Count, organization, project, repositoryId);
            return result;
        }
        catch (InvalidOperationException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching pull requests from Azure DevOps for {Organization}/{Project}/{Repo}", 
                organization, project, repositoryId);
            throw;
        }
    }

    private async System.Threading.Tasks.Task TryEnrichAzureDevOpsPullRequestStatsAsync(
        HttpClient httpClient,
        string organization,
        string project,
        string repositoryId,
        PullRequestDto dto,
        JsonElement listPrElement,
        CancellationToken cancellationToken)
    {
        try
        {
            var orgSeg = AzureDevOpsPathSegment(organization, nameof(organization));
            var projSeg = AzureDevOpsPathSegment(project, nameof(project));
            var repoSeg = AzureDevOpsPathSegment(repositoryId, nameof(repositoryId));

            string? sourceCommit = null;
            string? targetCommit = null;
            if (listPrElement.ValueKind == JsonValueKind.Object)
            {
                if (listPrElement.TryGetProperty("lastMergeSourceCommit", out var lms0)
                    && lms0.ValueKind == JsonValueKind.Object
                    && lms0.TryGetProperty("commitId", out var sid0)
                    && sid0.ValueKind == JsonValueKind.String)
                    sourceCommit = sid0.GetString();
                if (listPrElement.TryGetProperty("lastMergeTargetCommit", out var lmt0)
                    && lmt0.ValueKind == JsonValueKind.Object
                    && lmt0.TryGetProperty("commitId", out var tid0)
                    && tid0.ValueKind == JsonValueKind.String)
                    targetCommit = tid0.GetString();
            }

            if (string.IsNullOrEmpty(sourceCommit) || string.IsNullOrEmpty(targetCommit))
            {
                using var detailDoc = await FetchRepositoryPullRequestDetailJsonAsync(
                    httpClient,
                    organization,
                    project,
                    repositoryId,
                    dto.Number,
                    cancellationToken);
                if (detailDoc != null)
                {
                    var root = detailDoc.RootElement;
                    if (string.IsNullOrEmpty(sourceCommit)
                        && root.TryGetProperty("lastMergeSourceCommit", out var lms)
                        && lms.ValueKind == JsonValueKind.Object
                        && lms.TryGetProperty("commitId", out var sid)
                        && sid.ValueKind == JsonValueKind.String)
                        sourceCommit = sid.GetString();
                    if (string.IsNullOrEmpty(targetCommit)
                        && root.TryGetProperty("lastMergeTargetCommit", out var lmt)
                        && lmt.ValueKind == JsonValueKind.Object
                        && lmt.TryGetProperty("commitId", out var tid)
                        && tid.ValueKind == JsonValueKind.String)
                        targetCommit = tid.GetString();
                }
            }

            if (!string.IsNullOrEmpty(sourceCommit) && !string.IsNullOrEmpty(targetCommit))
            {
                var orientations = new (string Base, string Target)[]
                {
                    (targetCommit, sourceCommit),
                    (sourceCommit, targetCommit),
                };

                var bestLineSum = -1;
                foreach (var (baseCommit, targetC) in orientations)
                {
                    var diffUrl =
                        $"https://dev.azure.com/{orgSeg}/{projSeg}/_apis/git/repositories/{repoSeg}/diffs/commits?api-version={AzureDevOpsApiVersion}" +
                        $"&baseVersion={Uri.EscapeDataString(baseCommit)}" +
                        $"&targetVersion={Uri.EscapeDataString(targetC)}" +
                        "&baseVersionType=commit&targetVersionType=commit";
                    var diffResp = await httpClient.GetAsync(diffUrl, cancellationToken);
                    var diffBody = await diffResp.Content.ReadAsStringAsync(cancellationToken);
                    if (!diffResp.IsSuccessStatusCode || diffBody.TrimStart().StartsWith("<", StringComparison.Ordinal))
                        continue;
                    JsonDocument? diffDoc = null;
                    try
                    {
                        diffDoc = JsonDocument.Parse(diffBody);
                    }
                    catch (JsonException)
                    {
                        continue;
                    }

                    using (diffDoc)
                    {
                        var root = diffDoc!.RootElement;
                        var files = ComputeChangedFilesFromDiffRoot(root);
                        if (files > dto.ChangedFiles)
                            dto.ChangedFiles = files;

                        var ba = 0;
                        var bd = 0;
                        var bs = -1;
                        CollectBestLineStatsPair(root, ref ba, ref bd, ref bs);
                        if (bs >= 0 && bs > bestLineSum)
                        {
                            bestLineSum = bs;
                            dto.Additions = ba;
                            dto.Deletions = bd;
                        }
                    }
                }
            }

            if (dto.ChangedFiles == 0 && dto.Additions == 0 && dto.Deletions == 0)
                await TryEnrichPullRequestStatsFromLatestIterationAsync(
                    httpClient,
                    orgSeg,
                    projSeg,
                    repoSeg,
                    dto,
                    cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Azure DevOps PR {PrId} stats enrichment failed", dto.Number);
        }
    }

    private async System.Threading.Tasks.Task<JsonDocument?> FetchRepositoryPullRequestDetailJsonAsync(
        HttpClient httpClient,
        string organization,
        string project,
        string repositoryId,
        int pullRequestId,
        CancellationToken cancellationToken)
    {
        var url =
            $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/" +
            $"{AzureDevOpsPathSegment(project, nameof(project))}/_apis/git/repositories/" +
            $"{AzureDevOpsPathSegment(repositoryId, nameof(repositoryId))}/pullrequests/{pullRequestId}" +
            $"?api-version={AzureDevOpsApiVersion}";
        var response = await httpClient.GetAsync(url, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode || body.TrimStart().StartsWith("<", StringComparison.Ordinal))
            return null;
        try
        {
            return JsonDocument.Parse(body);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private async System.Threading.Tasks.Task TryEnrichPullRequestStatsFromLatestIterationAsync(
        HttpClient httpClient,
        string orgSeg,
        string projSeg,
        string repoSeg,
        PullRequestDto dto,
        CancellationToken cancellationToken)
    {
        var iterUrl =
            $"https://dev.azure.com/{orgSeg}/{projSeg}/_apis/git/repositories/{repoSeg}/pullrequests/{dto.Number}/iterations?api-version={AzureDevOpsApiVersion}";
        var iterResp = await httpClient.GetAsync(iterUrl, cancellationToken);
        var iterBody = await iterResp.Content.ReadAsStringAsync(cancellationToken);
        if (!iterResp.IsSuccessStatusCode || iterBody.TrimStart().StartsWith("<", StringComparison.Ordinal))
            return;

        using var iterDoc = JsonDocument.Parse(iterBody);
        if (!iterDoc.RootElement.TryGetProperty("value", out var iterArr) || iterArr.ValueKind != JsonValueKind.Array)
            return;

        int? latestId = null;
        foreach (var it in iterArr.EnumerateArray())
        {
            if (!it.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.Number)
                continue;
            var id = idEl.GetInt32();
            if (!latestId.HasValue || id > latestId.Value)
                latestId = id;
        }

        if (!latestId.HasValue)
            return;

        var chUrl =
            $"https://dev.azure.com/{orgSeg}/{projSeg}/_apis/git/repositories/{repoSeg}/pullrequests/{dto.Number}/iterations/{latestId.Value}/changes?api-version={AzureDevOpsApiVersion}";
        var chResp = await httpClient.GetAsync(chUrl, cancellationToken);
        var chBody = await chResp.Content.ReadAsStringAsync(cancellationToken);
        if (!chResp.IsSuccessStatusCode || chBody.TrimStart().StartsWith("<", StringComparison.Ordinal))
            return;

        using var chDoc = JsonDocument.Parse(chBody);
        var root = chDoc.RootElement;
        if (root.TryGetProperty("changeEntries", out var entries) && entries.ValueKind == JsonValueKind.Array)
            dto.ChangedFiles = Math.Max(dto.ChangedFiles, entries.GetArrayLength());
        else
            dto.ChangedFiles = Math.Max(dto.ChangedFiles, ComputeChangedFilesFromDiffRoot(root));

        var ba = 0;
        var bd = 0;
        var bs = -1;
        CollectBestLineStatsPair(root, ref ba, ref bd, ref bs);
        if (bs >= 0)
        {
            dto.Additions = ba;
            dto.Deletions = bd;
        }
    }

    private static int ComputeChangedFilesFromDiffRoot(JsonElement root)
    {
        var fromArray = 0;
        if (root.TryGetProperty("changes", out var changes) && changes.ValueKind == JsonValueKind.Array)
            fromArray = changes.GetArrayLength();
        return Math.Max(fromArray, SumChangeCountsObject(root));
    }

    private static int SumChangeCountsObject(JsonElement root)
    {
        if (!root.TryGetProperty("changeCounts", out var cc) || cc.ValueKind != JsonValueKind.Object)
            return 0;
        var sum = 0;
        foreach (var p in cc.EnumerateObject())
        {
            if (p.Value.ValueKind == JsonValueKind.Number)
                sum += p.Value.GetInt32();
        }
        return sum;
    }

    private static void CollectBestLineStatsPair(JsonElement el, ref int bestAdd, ref int bestDel, ref int bestSum)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.Object:
                int? la = null;
                int? ld = null;
                foreach (var p in el.EnumerateObject())
                {
                    if (p.Value.ValueKind != JsonValueKind.Number)
                        continue;
                    var n = p.Name;
                    if (n.Equals("linesAdded", StringComparison.OrdinalIgnoreCase)
                        || n.Equals("lineAdditions", StringComparison.OrdinalIgnoreCase)
                        || n.Equals("addLines", StringComparison.OrdinalIgnoreCase))
                        la = p.Value.GetInt32();
                    else if (n.Equals("linesDeleted", StringComparison.OrdinalIgnoreCase)
                        || n.Equals("lineDeletions", StringComparison.OrdinalIgnoreCase)
                        || n.Equals("deleteLines", StringComparison.OrdinalIgnoreCase))
                        ld = p.Value.GetInt32();
                }

                if (la.HasValue && ld.HasValue)
                {
                    var sum = la.Value + ld.Value;
                    if (sum > bestSum)
                    {
                        bestSum = sum;
                        bestAdd = la.Value;
                        bestDel = ld.Value;
                    }
                }

                foreach (var p in el.EnumerateObject())
                    CollectBestLineStatsPair(p.Value, ref bestAdd, ref bestDel, ref bestSum);
                break;
            case JsonValueKind.Array:
                foreach (var item in el.EnumerateArray())
                    CollectBestLineStatsPair(item, ref bestAdd, ref bestDel, ref bestSum);
                break;
        }
    }

    public async System.Threading.Tasks.Task<PullRequestStatusDto> GetPullRequestStatusAsync(
        string accessToken,
        string prUrl,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);

        try
        {
            // Parse Azure DevOps PR URL:
            // https://dev.azure.com/{organization}/{project}/_git/{repo}/pullrequest/{prId}
            var (organization, project, repositoryId, prId) = ParseAzureDevOpsPrUrl(prUrl);

            _logger.LogInformation("Checking Azure DevOps PR status for {Organization}/{Project}/{Repo}#{PrId}",
                organization, project, repositoryId, prId);

            var url = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/git/pullrequests/{prId}?api-version={AzureDevOpsApiVersion}";

            var response = await httpClient.GetAsync(url, cancellationToken);
            var content = await response.Content.ReadAsStringAsync(cancellationToken);

            if (content.TrimStart().StartsWith("<"))
            {
                throw new InvalidOperationException("Azure DevOps authentication failed. Please use a valid token.");
            }

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Azure DevOps PR status API failed: {StatusCode} - {Content}", response.StatusCode, content);
                throw new HttpRequestException($"Azure DevOps API returned {response.StatusCode}");
            }

            var pr = JsonDocument.Parse(content);
            var prStatus = pr.RootElement.TryGetProperty("status", out var s) ? s.GetString() ?? "unknown" : "unknown";

            // Azure DevOps PR statuses: "active", "completed", "abandoned"
            // "completed" = merged (completed PRs are merged)
            var isMerged = prStatus.Equals("completed", StringComparison.OrdinalIgnoreCase);
            var state = prStatus.ToLowerInvariant() switch
            {
                "active" => "open",
                "completed" => "closed",
                "abandoned" => "closed",
                _ => prStatus
            };

            string? mergedAt = null;
            if (isMerged && pr.RootElement.TryGetProperty("closedDate", out var closedDate) && closedDate.ValueKind != JsonValueKind.Null)
            {
                mergedAt = closedDate.GetString();
            }

            return new PullRequestStatusDto
            {
                State = state,
                IsMerged = isMerged,
                MergedAt = mergedAt
            };
        }
        catch (InvalidOperationException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting PR status for Azure DevOps PR {PrUrl}", prUrl);
            throw;
        }
    }

    /// <inheritdoc />
    public async System.Threading.Tasks.Task<string?> GetPullRequestHeadBranchAsync(
        string accessToken,
        string prUrl,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);

        try
        {
            var (organization, project, _, prId) = ParseAzureDevOpsPrUrl(prUrl);

            var url = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/git/pullrequests/{prId}?api-version={AzureDevOpsApiVersion}";

            var response = await httpClient.GetAsync(url, cancellationToken);
            var content = await response.Content.ReadAsStringAsync(cancellationToken);

            if (content.TrimStart().StartsWith("<"))
            {
                throw new InvalidOperationException("Azure DevOps authentication failed. Please use a valid token.");
            }

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Azure DevOps PR API failed: {StatusCode} - {Content}", response.StatusCode, content);
                throw new HttpRequestException($"Azure DevOps API returned {response.StatusCode}");
            }

            var pr = JsonDocument.Parse(content);
            if (!pr.RootElement.TryGetProperty("sourceRefName", out var sourceRef) ||
                sourceRef.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            return SourceRefToBranchName(sourceRef.GetString());
        }
        catch (InvalidOperationException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting PR head branch for Azure DevOps PR {PrUrl}", prUrl);
            throw;
        }
    }

    /// <summary>
    /// Converts refs/heads/my-branch to my-branch.
    /// </summary>
    private static string? SourceRefToBranchName(string? sourceRefName)
    {
        if (string.IsNullOrWhiteSpace(sourceRefName))
        {
            return null;
        }

        const string headsPrefix = "refs/heads/";
        return sourceRefName.StartsWith(headsPrefix, StringComparison.Ordinal)
            ? sourceRefName[headsPrefix.Length..]
            : sourceRefName;
    }

    public async System.Threading.Tasks.Task<IReadOnlyList<AzureDevOpsFeedDto>> GetFeedsAsync(
        string organization,
        string accessToken,
        CancellationToken cancellationToken = default)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth: true);

        try
        {
            var url = $"https://feeds.dev.azure.com/{organization}/_apis/packaging/feeds?api-version={AzureDevOpsApiVersion}";
            var response = await httpClient.GetAsync(url, cancellationToken);

            var content = await response.Content.ReadAsStringAsync(cancellationToken);

            if (content.TrimStart().StartsWith("<") || content.TrimStart().StartsWith("<!"))
            {
                _logger.LogError("Azure DevOps returned HTML instead of JSON for feeds query");
                throw new InvalidOperationException($"Azure DevOps authentication failed for organization '{organization}'.");
            }

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Azure DevOps feeds API failed: {StatusCode} - {Content}", response.StatusCode, content);
                throw new HttpRequestException($"Azure DevOps API returned {response.StatusCode}: {content}");
            }

            var doc = JsonDocument.Parse(content);
            var result = new List<AzureDevOpsFeedDto>();

            if (doc.RootElement.TryGetProperty("value", out var valueArray))
            {
                foreach (var feed in valueArray.EnumerateArray())
                {
                    string? projectName = null;
                    if (feed.TryGetProperty("project", out var proj) && proj.ValueKind == JsonValueKind.Object)
                    {
                        projectName = proj.TryGetProperty("name", out var pn) ? pn.GetString() : null;
                    }

                    result.Add(new AzureDevOpsFeedDto
                    {
                        Id = feed.TryGetProperty("id", out var id) ? id.GetString() ?? "" : "",
                        Name = feed.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "",
                        FullyQualifiedName = feed.TryGetProperty("fullyQualifiedName", out var fqn) ? fqn.GetString() : null,
                        Project = projectName,
                        Url = feed.TryGetProperty("url", out var feedUrl) ? feedUrl.GetString() : null,
                    });
                }
            }

            _logger.LogInformation("Found {Count} artifact feeds in organization {Organization}", result.Count, organization);
            return result;
        }
        catch (InvalidOperationException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching artifact feeds from Azure DevOps for organization {Organization}", organization);
            throw;
        }
    }

    /// <summary>Encode user-controlled Azure DevOps URL path segments and block path injection (Sonar S7044).</summary>
    private static string AzureDevOpsPathSegment(string value, string parameterName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        if (value.AsSpan().IndexOfAny('\r', '\n', '\0') >= 0)
            throw new ArgumentException($"Invalid value for {parameterName}.", parameterName);
        if (value.Contains("..", StringComparison.Ordinal))
            throw new ArgumentException($"Invalid value for {parameterName}.", parameterName);
        return Uri.EscapeDataString(value);
    }

    private static string EscapeWiqlStringLiteral(string value)
        => value.Replace("'", "''", StringComparison.Ordinal);

    /// <summary>Normalizes area path from REST/JSON to WIQL (Azure uses backslash-separated nodes).</summary>
    private static string NormalizeAdoAreaPath(string? p)
    {
        if (string.IsNullOrWhiteSpace(p)) return "";
        return p.Trim().Replace('/', '\\');
    }

    /// <summary>
    /// Loads every <see cref="System.AreaPath"/> from the project Areas tree so team field values (often partial) can
    /// be resolved to the full path; required so WIQL "UNDER" matches sub-areas (e.g. <c>Agentic\test team\TEST</c>).
    /// </summary>
    private static async System.Threading.Tasks.Task<HashSet<string>> FetchClassificationAreaPathSetAsync(
        HttpClient httpClient,
        string organization,
        string project,
        CancellationToken cancellationToken)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var doc = await FetchClassificationTreeDocumentAsync(
            httpClient, organization, project, ClassificationTreeAreas, cancellationToken);
        if (doc is null)
        {
            return result;
        }

        CollectAreaPathsFromClassificationNode(doc.RootElement, result);
        return result;
    }

    private static async System.Threading.Tasks.Task<HashSet<string>> FetchClassificationIterationPathSetAsync(
        HttpClient httpClient,
        string organization,
        string project,
        CancellationToken cancellationToken)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var doc = await FetchClassificationTreeDocumentAsync(
            httpClient, organization, project, ClassificationTreeIterations, cancellationToken);
        if (doc is null)
        {
            return result;
        }

        CollectAreaPathsFromClassificationNode(doc.RootElement, result);
        return result;
    }

    /// <summary>Parses a project classification JSON tree (Areas or Iterations), or <c>null</c> on failure.</summary>
    private static async System.Threading.Tasks.Task<JsonDocument?> FetchClassificationTreeDocumentAsync(
        HttpClient httpClient,
        string organization,
        string project,
        string areasOrIterations,
        CancellationToken cancellationToken)
    {
        if (!string.Equals(areasOrIterations, ClassificationTreeAreas, StringComparison.Ordinal) &&
            !string.Equals(areasOrIterations, ClassificationTreeIterations, StringComparison.Ordinal))
        {
            throw new ArgumentException("Only Areas or Iterations are supported.", nameof(areasOrIterations));
        }

        var url = $"https://dev.azure.com/{AzureDevOpsPathSegment(organization, nameof(organization))}/{AzureDevOpsPathSegment(project, nameof(project))}/_apis/wit/classificationnodes/{areasOrIterations}?api-version={AzureDevOpsApiVersion}&$depth=14";
        var response = await httpClient.GetAsync(url, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        var content = await response.Content.ReadAsStringAsync(cancellationToken);
        if (string.IsNullOrWhiteSpace(content) || content.TrimStart().StartsWith('<'))
        {
            return null;
        }

        try
        {
            return JsonDocument.Parse(content);
        }
        catch
        {
            return null;
        }
    }

    private static void CollectAreaPathOptionsFromClassificationNode(
        JsonElement node, List<AzureDevOpsAreaPathOptionDto> acc)
    {
        if (TryGetClassificationNodeId(node, out var id) && id > 0 && node.TryGetProperty("path", out var pathEl))
        {
            var p = pathEl.GetString();
            if (!string.IsNullOrEmpty(p))
            {
                p = NormalizeAdoAreaPath(p).TrimStart('\\');
                if (!string.IsNullOrEmpty(p))
                {
                    acc.Add(new AzureDevOpsAreaPathOptionDto { Id = id, Path = p });
                }
            }
        }

        if (node.TryGetProperty("children", out var ch) && ch.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in ch.EnumerateArray())
            {
                CollectAreaPathOptionsFromClassificationNode(c, acc);
            }
        }
    }

    private static bool TryGetClassificationNodeId(JsonElement node, out int id)
    {
        id = 0;
        if (!node.TryGetProperty("id", out var idEl))
        {
            return false;
        }

        if (idEl.ValueKind == JsonValueKind.Number)
        {
            id = idEl.GetInt32();
            return id > 0;
        }

        if (idEl.ValueKind == JsonValueKind.String)
        {
            return int.TryParse(idEl.GetString(), System.Globalization.NumberStyles.Integer, null, out id) && id > 0;
        }

        return false;
    }

    private static bool TryFindClassificationNodeById(
        JsonElement node, int targetId, out JsonElement found)
    {
        if (TryGetClassificationNodeId(node, out var id) && id == targetId)
        {
            found = node;
            return true;
        }

        if (node.TryGetProperty("children", out var ch) && ch.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in ch.EnumerateArray())
            {
                if (TryFindClassificationNodeById(c, targetId, out found))
                {
                    return true;
                }
            }
        }

        found = default;
        return false;
    }

    private static void CollectClassificationNodeAndDescendantIds(JsonElement node, List<int> ids)
    {
        if (TryGetClassificationNodeId(node, out var id) && id > 0)
        {
            ids.Add(id);
        }

        if (node.TryGetProperty("children", out var ch) && ch.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in ch.EnumerateArray())
            {
                CollectClassificationNodeAndDescendantIds(c, ids);
            }
        }
    }

    private static void CollectAreaPathsFromClassificationNode(JsonElement node, HashSet<string> paths)
    {
        if (node.TryGetProperty("path", out var pathEl))
        {
            var p = pathEl.GetString();
            if (!string.IsNullOrEmpty(p))
            {
                p = NormalizeAdoAreaPath(p).TrimStart('\\');
                if (!string.IsNullOrEmpty(p))
                {
                    paths.Add(p);
                }
            }
        }

        if (node.TryGetProperty("children", out var ch) && ch.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in ch.EnumerateArray())
            {
                CollectAreaPathsFromClassificationNode(c, paths);
            }
        }
    }

    /// <summary>Maps team field value / default path to the canonical <c>System.AreaPath</c> from classification.</summary>
    private string ResolveToCanonicalAreaPath(
        string project,
        string? raw,
        IReadOnlyCollection<string> classificationPaths)
    {
        var n = NormalizeAdoAreaPath(raw);
        if (string.IsNullOrEmpty(n))
        {
            return n;
        }

        var proj = project.Trim();
        if (classificationPaths.Count == 0)
        {
            if (!n.StartsWith(proj + "\\", StringComparison.OrdinalIgnoreCase) && n.IndexOf('\\') < 0)
            {
                return proj + "\\" + n;
            }
            if (!n.StartsWith(proj + "\\", StringComparison.OrdinalIgnoreCase) && n.IndexOf('\\') >= 0)
            {
                return proj + "\\" + n;
            }
            return n;
        }

        var byExact = classificationPaths.FirstOrDefault(p => p.Equals(n, StringComparison.OrdinalIgnoreCase));
        if (byExact is not null)
        {
            return byExact;
        }

        if (!n.StartsWith(proj + "\\", StringComparison.OrdinalIgnoreCase))
        {
            var guess = proj + "\\" + n;
            var byPrefix = classificationPaths.FirstOrDefault(p => p.Equals(guess, StringComparison.OrdinalIgnoreCase));
            if (byPrefix is not null)
            {
                _logger.LogDebug("Resolved area path {Raw} to {Full} (project prefix + classification)", raw, byPrefix);
                return byPrefix;
            }
        }

        var asSuffix = classificationPaths
            .Where(f =>
            {
                if (f.Equals(n, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
                if (f.EndsWith("\\" + n, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
                return false;
            })
            .OrderBy(f => f.Length)
            .FirstOrDefault();

        if (asSuffix is not null)
        {
            _logger.LogDebug("Resolved area path {Raw} to {Full} (suffix match in Areas tree)", raw, asSuffix);
            return asSuffix;
        }

        if (!n.StartsWith(proj + "\\", StringComparison.OrdinalIgnoreCase) && n.IndexOf('\\') >= 0)
        {
            return proj + "\\" + n;
        }
        if (!n.StartsWith(proj + "\\", StringComparison.OrdinalIgnoreCase) && n.IndexOf('\\') < 0)
        {
            return proj + "\\" + n;
        }
        return n;
    }

    private static void EnsureSafeGitPath(string? path, string parameterName)
    {
        if (string.IsNullOrEmpty(path)) return;
        if (path.Contains("..", StringComparison.Ordinal)
            || path.AsSpan().IndexOfAny('\0', '\r', '\n') >= 0)
            throw new ArgumentException($"Invalid value for {parameterName}.", parameterName);
    }

    /// <summary>
    /// Parses an Azure DevOps PR URL to extract organization, project, repository, and PR ID.
    /// Expected format: https://dev.azure.com/{organization}/{project}/_git/{repo}/pullrequest/{prId}
    /// </summary>
    private static (string organization, string project, string repositoryId, int prId) ParseAzureDevOpsPrUrl(string prUrl)
    {
        prUrl = prUrl.TrimEnd('/');

        if (!Uri.TryCreate(prUrl, UriKind.Absolute, out var uri))
        {
            throw new ArgumentException($"Invalid Azure DevOps PR URL format: {prUrl}");
        }

        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);

        // Expected: /{organization}/{project}/_git/{repo}/pullrequest/{prId}
        // segments: [organization, project, _git, repo, pullrequest, prId]
        if (segments.Length < 6 || segments[2] != "_git" || segments[4] != "pullrequest")
        {
            throw new ArgumentException($"Invalid Azure DevOps PR URL format. Expected: https://dev.azure.com/org/project/_git/repo/pullrequest/123, got: {prUrl}");
        }

        var organization = segments[0];
        var project = segments[1];
        var repositoryId = segments[3];

        if (!int.TryParse(segments[5], out var prId))
        {
            throw new ArgumentException($"Invalid PR ID in Azure DevOps URL: {prUrl}");
        }

        return (organization, project, repositoryId, prId);
    }
}
