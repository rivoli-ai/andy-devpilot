namespace DevPilot.Infrastructure.AzureDevOps;

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
                $"https://app.vssps.visualstudio.com/_apis/accounts?memberId={memberId}&api-version=6.0",
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
                $"https://dev.azure.com/{organization}/_apis/projects?api-version={AzureDevOpsApiVersion}",
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
                $"https://dev.azure.com/{organization}/{project}/_apis/git/repositories?api-version={AzureDevOpsApiVersion}",
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

            var url = $"https://dev.azure.com/{organization}/{project}/_apis/git/repositories/{repositoryId}/pullrequests?api-version={AzureDevOpsApiVersion}";
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
            var prUrl = $"https://dev.azure.com/{organization}/{project}/_git/{repositoryId}/pullrequest/{prId}";

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
                $"https://dev.azure.com/{organization}/_apis/projects/{project}/teams?api-version={AzureDevOpsApiVersion}",
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

    public async System.Threading.Tasks.Task<AzureDevOpsWorkItemsHierarchyDto> GetWorkItemsAsync(
        string accessToken,
        string organization,
        string project,
        string? teamId = null,
        CancellationToken cancellationToken = default,
        bool useBasicAuth = false)
    {
        var httpClient = CreateHttpClient(accessToken, useBasicAuth);

        try
        {
            var result = new AzureDevOpsWorkItemsHierarchyDto();

            // When teamId is provided, fetch team's area paths via Team Field Values API and filter WIQL
            string? areaPathFilter = null;
            if (!string.IsNullOrEmpty(teamId))
            {
                try
                {
                    var teamFieldValuesUrl = $"https://dev.azure.com/{organization}/{project}/{teamId}/_apis/work/teamsettings/teamfieldvalues?api-version={AzureDevOpsApiVersion}";
                    var teamFieldResponse = await httpClient.GetAsync(teamFieldValuesUrl, cancellationToken);
                    if (teamFieldResponse.IsSuccessStatusCode)
                    {
                        var teamFieldContent = await teamFieldResponse.Content.ReadAsStringAsync(cancellationToken);
                        var teamFieldDoc = JsonDocument.Parse(teamFieldContent);
                        var root = teamFieldDoc.RootElement;

                        // Team Field Values returns: { "defaultValue": "Project\\Team", "values": [{ "value": "...", "includeChildren": true }] }
                        var areaPaths = new List<string>();
                        if (root.TryGetProperty("defaultValue", out var defaultVal))
                        {
                            var path = defaultVal.GetString();
                            if (!string.IsNullOrEmpty(path)) areaPaths.Add(path);
                        }
                        if (root.TryGetProperty("values", out var valuesArr))
                        {
                            foreach (var v in valuesArr.EnumerateArray())
                            {
                                if (v.TryGetProperty("value", out var valProp))
                                {
                                    var path = valProp.GetString();
                                    if (!string.IsNullOrEmpty(path) && !areaPaths.Contains(path))
                                        areaPaths.Add(path);
                                }
                            }
                        }

                        if (areaPaths.Count > 0)
                        {
                            // Build OR clause: (AreaPath UNDER 'path1' OR AreaPath UNDER 'path2' ...)
                            var underClauses = areaPaths.Select(p => $"[System.AreaPath] UNDER '{p.Replace("'", "''")}'");
                            areaPathFilter = " AND (" + string.Join(" OR ", underClauses) + ")";
                            _logger.LogInformation("Team {TeamId} area paths: {Paths}", teamId, string.Join(", ", areaPaths));
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
                          WHERE [System.TeamProject] = '{project}'{areaFilter}
                          AND [System.WorkItemType] IN ('Epic', 'Feature', 'User Story', 'Task', 'Bug', 'Product Backlog Item')
                          ORDER BY [System.WorkItemType], [System.Id]"
            };

            var jsonContent = new StringContent(
                JsonSerializer.Serialize(wiqlQuery),
                Encoding.UTF8,
                "application/json");

            var wiqlUrl = $"https://dev.azure.com/{organization}/{project}/_apis/wit/wiql?api-version={AzureDevOpsApiVersion}";
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
                    $"https://dev.azure.com/{organization}/{project}/_apis/wit/workitems?ids={idsParam}&$expand=relations&api-version={AzureDevOpsApiVersion}",
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
                Url = $"https://dev.azure.com/{organization}/{project}/_workitems/edit/{id}"
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
            // Get default branch if not specified
            if (string.IsNullOrEmpty(branch))
            {
                var reposResponse = await httpClient.GetAsync(
                    $"https://dev.azure.com/{organization}/{project}/_apis/git/repositories/{repositoryId}?api-version={AzureDevOpsApiVersion}",
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
            var url = $"https://dev.azure.com/{organization}/{project}/_apis/git/repositories/{repositoryId}/items?scopePath={Uri.EscapeDataString(scopePath)}&recursionLevel=OneLevel&versionDescriptor.version={Uri.EscapeDataString(branch)}&versionDescriptor.versionType=branch&api-version={AzureDevOpsApiVersion}";

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
            branch ??= "main";
            var filePath = path.StartsWith("/") ? path : $"/{path}";
            
            var url = $"https://dev.azure.com/{organization}/{project}/_apis/git/repositories/{repositoryId}/items?path={Uri.EscapeDataString(filePath)}&versionDescriptor.version={Uri.EscapeDataString(branch)}&versionDescriptor.versionType=branch&includeContent=true&api-version={AzureDevOpsApiVersion}";

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
                $"https://dev.azure.com/{organization}/{project}/_apis/git/repositories/{repositoryId}?api-version={AzureDevOpsApiVersion}",
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
                $"https://dev.azure.com/{organization}/{project}/_apis/git/repositories/{repositoryId}/refs?filter=heads/&api-version={AzureDevOpsApiVersion}",
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

            var url = $"https://dev.azure.com/{organization}/{project}/_apis/git/repositories/{repositoryId}/pullrequests?searchCriteria.status={statusFilter}&api-version={AzureDevOpsApiVersion}";

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

            var prResponse = JsonDocument.Parse(content);
            var result = new List<PullRequestDto>();

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
                        Url = $"https://dev.azure.com/{organization}/{project}/_git/{repositoryId}/pullrequest/{prId}",
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

                    result.Add(prDto);
                }
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
}
