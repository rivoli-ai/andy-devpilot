namespace DevPilot.API.Controllers;

using System.Text;
using System.ComponentModel.DataAnnotations;
using DevPilot.Application.DTOs;
using DevPilot.Application.Queries;
using DevPilot.Application.Services;
using System.Security.Claims;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using UserEntity = DevPilot.Domain.Entities.User;
using DevPilot.Infrastructure.Auth;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Octokit;

/// <summary>
/// Controller for authentication: Email/Password, GitHub OAuth, Microsoft OAuth
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class AuthController : ControllerBase
{
    private readonly IConfiguration _configuration;
    private readonly IUserRepository _userRepository;
    private readonly ILinkedProviderRepository _linkedProviderRepository;
    private readonly IGitHubService _gitHubService;
    private readonly AuthenticationService _authenticationService;
    private readonly IMediator _mediator;
    private readonly ILogger<AuthController> _logger;

    public AuthController(
        IConfiguration configuration,
        IUserRepository userRepository,
        ILinkedProviderRepository linkedProviderRepository,
        IGitHubService gitHubService,
        AuthenticationService authenticationService,
        IMediator mediator,
        ILogger<AuthController> logger)
    {
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
        _linkedProviderRepository = linkedProviderRepository ?? throw new ArgumentNullException(nameof(linkedProviderRepository));
        _gitHubService = gitHubService ?? throw new ArgumentNullException(nameof(gitHubService));
        _authenticationService = authenticationService ?? throw new ArgumentNullException(nameof(authenticationService));
        _mediator = mediator ?? throw new ArgumentNullException(nameof(mediator));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    #region Email/Password Authentication

    /// <summary>
    /// Register a new user with email and password
    /// </summary>
    [HttpPost("register")]
    public async Task<IActionResult> Register([FromBody] RegisterRequest request, CancellationToken cancellationToken)
    {
        // Validate request
        if (string.IsNullOrWhiteSpace(request.Email))
            return BadRequest(new { message = "Email is required" });

        if (string.IsNullOrWhiteSpace(request.Password))
            return BadRequest(new { message = "Password is required" });

        // Validate email format
        if (!new EmailAddressAttribute().IsValid(request.Email))
            return BadRequest(new { message = "Invalid email format" });

        // Validate password strength
        var (isValid, errorMessage) = _authenticationService.ValidatePassword(request.Password);
        if (!isValid)
            return BadRequest(new { message = errorMessage });

        try
        {
            // Check if user already exists
            var existingUser = await _userRepository.GetByEmailAsync(request.Email, cancellationToken);
            if (existingUser != null)
            {
                return Conflict(new { message = "A user with this email already exists" });
            }

            // Hash password and create user
            var passwordHash = _authenticationService.HashPassword(request.Password);
            var user = UserEntity.CreateWithPassword(request.Email, passwordHash, request.Name);
            
            await _userRepository.AddAsync(user, cancellationToken);

            // Generate JWT token
            var jwtToken = _authenticationService.GenerateToken(user.Id, user.Email);

            _logger.LogInformation("New user registered: {Email}", request.Email);

            return Ok(new AuthResponse
            {
                Token = jwtToken,
                User = new UserDto
                {
                    Id = user.Id,
                    Email = user.Email,
                    Name = user.Name,
                    EmailVerified = user.EmailVerified
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during user registration for {Email}", request.Email);
            return StatusCode(500, new { message = "An error occurred during registration" });
        }
    }

    /// <summary>
    /// Login with email and password
    /// </summary>
    [HttpPost("login")]
    public async Task<IActionResult> Login([FromBody] LoginRequest request, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Email) || string.IsNullOrWhiteSpace(request.Password))
            return BadRequest(new { message = "Email and password are required" });

        try
        {
            // Find user by email
            var user = await _userRepository.GetByEmailAsync(request.Email, cancellationToken);
            if (user == null)
            {
                return Unauthorized(new { message = "Invalid email or password" });
            }

            // Check if user has a password (might have signed up with OAuth)
            if (!user.HasPassword())
            {
                return BadRequest(new { message = "This account uses social login. Please sign in with GitHub or Microsoft." });
            }

            // Verify password
            if (!_authenticationService.VerifyPassword(request.Password, user.PasswordHash!))
            {
                return Unauthorized(new { message = "Invalid email or password" });
            }

            // Generate JWT token
            var jwtToken = _authenticationService.GenerateToken(user.Id, user.Email);

            _logger.LogInformation("User logged in: {Email}", request.Email);

            return Ok(new AuthResponse
            {
                Token = jwtToken,
                User = new UserDto
                {
                    Id = user.Id,
                    Email = user.Email,
                    Name = user.Name,
                    EmailVerified = user.EmailVerified,
                    GitHubUsername = user.GitHubUsername
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during login for {Email}", request.Email);
            return StatusCode(500, new { message = "An error occurred during login" });
        }
    }

    #endregion

    #region GitHub OAuth

    /// <summary>
    /// Get GitHub OAuth2 authorization URL
    /// </summary>
    [HttpGet("github/authorize")]
    public IActionResult GetGitHubAuthorizationUrl()
    {
        var clientId = _configuration["GitHub:ClientId"] ?? throw new InvalidOperationException("GitHub:ClientId not configured");
        var redirectUri = _configuration["GitHub:RedirectUri"] ?? "http://localhost:4200/auth/callback";
        
        var authUrl = $"https://github.com/login/oauth/authorize?client_id={Uri.EscapeDataString(clientId)}&redirect_uri={Uri.EscapeDataString(redirectUri)}&scope=repo";
        
        return Ok(new { authorizationUrl = authUrl });
    }

    /// <summary>
    /// Handle GitHub OAuth2 callback and generate JWT token
    /// </summary>
    [HttpPost("github/callback")]
    public async Task<IActionResult> GitHubCallback([FromBody] GitHubCallbackRequest request, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Code))
        {
            return BadRequest("Authorization code is required");
        }

        try
        {
            // Exchange authorization code for access token
            var clientId = _configuration["GitHub:ClientId"] ?? throw new InvalidOperationException("GitHub:ClientId not configured");
            var clientSecret = _configuration["GitHub:ClientSecret"] ?? throw new InvalidOperationException("GitHub:ClientSecret not configured");
            var redirectUri = _configuration["GitHub:RedirectUri"] ?? "http://localhost:4200/auth/callback";

            // Exchange authorization code for access token using GitHub API
            // GitHub returns form-encoded data, not JSON
            using var httpClient = new HttpClient();
            httpClient.DefaultRequestHeaders.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));
            
            var tokenRequestContent = new FormUrlEncodedContent(new[]
            {
                new KeyValuePair<string, string>("client_id", clientId),
                new KeyValuePair<string, string>("client_secret", clientSecret),
                new KeyValuePair<string, string>("code", request.Code),
                new KeyValuePair<string, string>("redirect_uri", redirectUri)
            });

            var tokenResponse = await httpClient.PostAsync("https://github.com/login/oauth/access_token", tokenRequestContent, cancellationToken);
            var tokenResponseContent = await tokenResponse.Content.ReadAsStringAsync(cancellationToken);

            // Check if GitHub returned an error
            if (!tokenResponse.IsSuccessStatusCode)
            {
                _logger.LogError("GitHub token exchange failed: {StatusCode} - {Response}", tokenResponse.StatusCode, tokenResponseContent);
                return BadRequest($"Failed to exchange authorization code: {tokenResponseContent}");
            }

            // Parse access token from response (format: access_token=xxx&token_type=bearer)
            // GitHub also returns JSON format if Accept: application/json header is present
            var accessToken = ParseAccessTokenFromResponse(tokenResponseContent);

            if (string.IsNullOrWhiteSpace(accessToken))
            {
                _logger.LogError("Failed to parse access token from GitHub response: {Response}", tokenResponseContent);
                return BadRequest($"Failed to parse access token from GitHub response: {tokenResponseContent}");
            }

            // Get GitHub user information
            var userClient = new GitHubClient(new ProductHeaderValue("DevPilot"))
            {
                Credentials = new Credentials(accessToken)
            };

            var githubUser = await userClient.User.Current();

            // Find or create user
            var user = await _userRepository.GetByEmailAsync(githubUser.Email ?? githubUser.Login, cancellationToken);

            if (user == null)
            {
                user = new Domain.Entities.User(githubUser.Email ?? githubUser.Login, githubUser.Name);
                await _userRepository.AddAsync(user, cancellationToken);
            }

            // Update GitHub token
            user.UpdateGitHubToken(accessToken);
            user.UpdateGitHubUsername(githubUser.Login);
            await _userRepository.UpdateAsync(user, cancellationToken);

            // Generate JWT token
            var jwtToken = _authenticationService.GenerateToken(user.Id, user.Email);

            // Sync repositories automatically on login
            // Note: This happens in the background, frontend can call sync endpoint separately if needed

            return Ok(new AuthResponse
            {
                Token = jwtToken,
                User = new UserDto
                {
                    Id = user.Id,
                    Email = user.Email,
                    Name = user.Name,
                    GitHubUsername = user.GitHubUsername
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing GitHub OAuth callback");
            return BadRequest($"Error processing OAuth callback: {ex.Message}");
        }
    }

    /// <summary>
    /// Parse access token from GitHub OAuth response
    /// Supports both form-encoded and JSON formats
    /// </summary>
    private string? ParseAccessTokenFromResponse(string response)
    {
        // Try JSON format first (if Accept: application/json header was used)
        try
        {
            var jsonDoc = System.Text.Json.JsonDocument.Parse(response);
            if (jsonDoc.RootElement.TryGetProperty("access_token", out var tokenElement))
            {
                return tokenElement.GetString();
            }
        }
        catch
        {
            // Not JSON, try form-encoded format
        }

        // Response format: access_token=xxx&token_type=bearer&scope=repo
        var parts = response.Split('&');
        foreach (var part in parts)
        {
            var keyValue = part.Split('=', 2);
            if (keyValue.Length == 2 && keyValue[0] == "access_token")
            {
                return Uri.UnescapeDataString(keyValue[1]);
            }
        }
        return null;
    }

    #endregion

    #region Microsoft OAuth

    /// <summary>
    /// Get Microsoft OAuth2 authorization URL
    /// </summary>
    [HttpGet("microsoft/authorize")]
    public IActionResult GetMicrosoftAuthorizationUrl()
    {
        var clientId = _configuration["Microsoft:ClientId"] ?? throw new InvalidOperationException("Microsoft:ClientId not configured");
        var tenantId = _configuration["Microsoft:TenantId"] ?? "common";
        var redirectUri = _configuration["Microsoft:RedirectUri"] ?? "http://localhost:4200/auth/callback/microsoft";
        
        // Use minimal scopes that don't require admin consent
        var scope = "openid profile email";
        
        // Generate a random state for CSRF protection
        var state = Guid.NewGuid().ToString("N");
        
        var authUrl = $"https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize" +
            $"?client_id={Uri.EscapeDataString(clientId)}" +
            $"&response_type=code" +
            $"&redirect_uri={Uri.EscapeDataString(redirectUri)}" +
            $"&scope={Uri.EscapeDataString(scope)}" +
            $"&response_mode=query" +
            $"&state={state}";
        
        _logger.LogInformation("Microsoft OAuth URL generated. Redirect URI: {RedirectUri}", redirectUri);
        
        return Ok(new { authorizationUrl = authUrl });
    }

    /// <summary>
    /// Handle Microsoft OAuth2 callback and generate JWT token
    /// </summary>
    [HttpPost("microsoft/callback")]
    public async Task<IActionResult> MicrosoftCallback([FromBody] MicrosoftCallbackRequest request, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Code))
        {
            return BadRequest(new { message = "Authorization code is required" });
        }

        try
        {
            var clientId = _configuration["Microsoft:ClientId"] ?? throw new InvalidOperationException("Microsoft:ClientId not configured");
            var clientSecret = _configuration["Microsoft:ClientSecret"] ?? throw new InvalidOperationException("Microsoft:ClientSecret not configured");
            var tenantId = _configuration["Microsoft:TenantId"] ?? "common";
            var redirectUri = _configuration["Microsoft:RedirectUri"] ?? "http://localhost:4200/auth/callback/microsoft";

            // Exchange authorization code for access token
            using var httpClient = new HttpClient();
            
            var tokenRequestContent = new FormUrlEncodedContent(new[]
            {
                new KeyValuePair<string, string>("client_id", clientId),
                new KeyValuePair<string, string>("client_secret", clientSecret),
                new KeyValuePair<string, string>("code", request.Code),
                new KeyValuePair<string, string>("redirect_uri", redirectUri),
                new KeyValuePair<string, string>("grant_type", "authorization_code"),
                new KeyValuePair<string, string>("scope", "openid profile email")
            });

            var tokenResponse = await httpClient.PostAsync(
                $"https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token",
                tokenRequestContent,
                cancellationToken);
            
            var tokenResponseContent = await tokenResponse.Content.ReadAsStringAsync(cancellationToken);

            if (!tokenResponse.IsSuccessStatusCode)
            {
                _logger.LogError("Microsoft token exchange failed: {StatusCode} - {Response}", tokenResponse.StatusCode, tokenResponseContent);
                return BadRequest(new { message = $"Failed to exchange authorization code: {tokenResponseContent}" });
            }

            // Parse token response
            var tokenData = System.Text.Json.JsonDocument.Parse(tokenResponseContent);
            var accessToken = tokenData.RootElement.GetProperty("access_token").GetString();

            if (string.IsNullOrWhiteSpace(accessToken))
            {
                return BadRequest(new { message = "Failed to parse access token from Microsoft response" });
            }

            // Get user info from Microsoft Graph API
            httpClient.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);
            var graphResponse = await httpClient.GetAsync("https://graph.microsoft.com/v1.0/me", cancellationToken);
            var graphContent = await graphResponse.Content.ReadAsStringAsync(cancellationToken);

            if (!graphResponse.IsSuccessStatusCode)
            {
                _logger.LogError("Microsoft Graph API failed: {StatusCode} - {Response}", graphResponse.StatusCode, graphContent);
                return BadRequest(new { message = "Failed to get user info from Microsoft" });
            }

            var graphData = System.Text.Json.JsonDocument.Parse(graphContent);
            var microsoftUserId = graphData.RootElement.GetProperty("id").GetString() ?? "";
            var email = graphData.RootElement.TryGetProperty("mail", out var mailElement) ? mailElement.GetString() : null;
            var upn = graphData.RootElement.TryGetProperty("userPrincipalName", out var upnElement) ? upnElement.GetString() : null;
            var displayName = graphData.RootElement.TryGetProperty("displayName", out var nameElement) ? nameElement.GetString() : null;
            
            // Use email or UPN as the identifier
            var userEmail = email ?? upn ?? throw new InvalidOperationException("Could not get email from Microsoft account");

            // Find or create user
            var user = await _userRepository.GetByEmailAsync(userEmail, cancellationToken);

            if (user == null)
            {
                user = new Domain.Entities.User(userEmail, displayName);
                await _userRepository.AddAsync(user, cancellationToken);
            }
            else
            {
                // Update name if not set
                if (string.IsNullOrEmpty(user.Name) && !string.IsNullOrEmpty(displayName))
                {
                    user.UpdateName(displayName);
                    await _userRepository.UpdateAsync(user, cancellationToken);
                }
            }

            // Generate JWT token
            var jwtToken = _authenticationService.GenerateToken(user.Id, user.Email);

            _logger.LogInformation("User authenticated via Microsoft: {Email}", userEmail);

            return Ok(new AuthResponse
            {
                Token = jwtToken,
                User = new UserDto
                {
                    Id = user.Id,
                    Email = user.Email,
                    Name = user.Name,
                    EmailVerified = user.EmailVerified
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing Microsoft OAuth callback");
            return BadRequest(new { message = $"Error processing OAuth callback: {ex.Message}" });
        }
    }

    #endregion

    #region Linked Providers Management

    /// <summary>
    /// Get all linked providers for the current user
    /// </summary>
    [HttpGet("providers")]
    [Authorize]
    public async Task<IActionResult> GetLinkedProviders(CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        var providers = await _linkedProviderRepository.GetByUserIdAsync(userId.Value, cancellationToken);
        
        return Ok(providers.Select(p => new LinkedProviderDto
        {
            Id = p.Id,
            Provider = p.Provider,
            ProviderUsername = p.ProviderUsername,
            LinkedAt = p.CreatedAt
        }));
    }

    /// <summary>
    /// Link GitHub provider to current user's account
    /// </summary>
    [HttpPost("link/github")]
    [Authorize]
    public async Task<IActionResult> LinkGitHub([FromBody] LinkProviderRequest request, CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        try
        {
            // Exchange code for access token
            var clientId = _configuration["GitHub:ClientId"] ?? throw new InvalidOperationException("GitHub:ClientId not configured");
            var clientSecret = _configuration["GitHub:ClientSecret"] ?? throw new InvalidOperationException("GitHub:ClientSecret not configured");
            var redirectUri = request.RedirectUri ?? _configuration["GitHub:RedirectUri"] ?? "http://localhost:4200/auth/callback";

            using var httpClient = new HttpClient();
            httpClient.DefaultRequestHeaders.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));
            
            var tokenRequestContent = new FormUrlEncodedContent(new[]
            {
                new KeyValuePair<string, string>("client_id", clientId),
                new KeyValuePair<string, string>("client_secret", clientSecret),
                new KeyValuePair<string, string>("code", request.Code),
                new KeyValuePair<string, string>("redirect_uri", redirectUri)
            });

            var tokenResponse = await httpClient.PostAsync("https://github.com/login/oauth/access_token", tokenRequestContent, cancellationToken);
            var tokenResponseContent = await tokenResponse.Content.ReadAsStringAsync(cancellationToken);

            var accessToken = ParseAccessTokenFromResponse(tokenResponseContent);
            if (string.IsNullOrWhiteSpace(accessToken))
            {
                return BadRequest(new { message = "Failed to exchange authorization code" });
            }

            // Get GitHub user info
            var userClient = new GitHubClient(new ProductHeaderValue("DevPilot"))
            {
                Credentials = new Credentials(accessToken)
            };
            var githubUser = await userClient.User.Current();

            // Check if this provider is already linked to another user
            var existingLink = await _linkedProviderRepository.GetByProviderUserIdAsync(ProviderTypes.GitHub, githubUser.Id.ToString(), cancellationToken);
            if (existingLink != null && existingLink.UserId != userId.Value)
            {
                return Conflict(new { message = "This GitHub account is already linked to another user" });
            }

            // Check if user already has GitHub linked
            var userLink = await _linkedProviderRepository.GetByUserAndProviderAsync(userId.Value, ProviderTypes.GitHub, cancellationToken);
            if (userLink != null)
            {
                // Update existing link
                userLink.UpdateToken(accessToken);
                userLink.UpdateProviderUsername(githubUser.Login);
                await _linkedProviderRepository.UpdateAsync(userLink, cancellationToken);
            }
            else
            {
                // Create new link
                var linkedProvider = new LinkedProvider(
                    userId.Value,
                    ProviderTypes.GitHub,
                    githubUser.Id.ToString(),
                    accessToken,
                    githubUser.Login
                );
                await _linkedProviderRepository.AddAsync(linkedProvider, cancellationToken);
            }

            // Also update legacy field for backward compatibility
            var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
            if (user != null)
            {
                user.UpdateGitHubToken(accessToken);
                user.UpdateGitHubUsername(githubUser.Login);
                await _userRepository.UpdateAsync(user, cancellationToken);
            }

            _logger.LogInformation("User {UserId} linked GitHub account: {GitHubUsername}", userId, githubUser.Login);

            return Ok(new { message = "GitHub account linked successfully", username = githubUser.Login });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error linking GitHub account");
            return BadRequest(new { message = $"Error linking GitHub account: {ex.Message}" });
        }
    }

    /// <summary>
    /// Link Azure DevOps provider to current user's account
    /// Uses Microsoft Entra ID OAuth (Azure DevOps deprecated their own OAuth)
    /// </summary>
    [HttpPost("link/azure-devops")]
    [Authorize]
    public async Task<IActionResult> LinkAzureDevOps([FromBody] LinkProviderRequest request, CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        try
        {
            // Use Microsoft app registration - Azure DevOps now requires Entra ID
            var clientId = _configuration["Microsoft:ClientId"] ?? throw new InvalidOperationException("Microsoft:ClientId not configured");
            var clientSecret = _configuration["Microsoft:ClientSecret"] ?? throw new InvalidOperationException("Microsoft:ClientSecret not configured");
            var tenantId = _configuration["Microsoft:TenantId"] ?? "common";
            var redirectUri = request.RedirectUri ?? _configuration["AzureDevOps:RedirectUri"] ?? "http://localhost:4200/auth/callback/azure-devops";

            using var httpClient = new HttpClient();
            
            // Use standard OAuth 2.0 token exchange with Microsoft Entra ID
            var tokenRequestContent = new FormUrlEncodedContent(new[]
            {
                new KeyValuePair<string, string>("client_id", clientId),
                new KeyValuePair<string, string>("client_secret", clientSecret),
                new KeyValuePair<string, string>("code", request.Code),
                new KeyValuePair<string, string>("redirect_uri", redirectUri),
                new KeyValuePair<string, string>("grant_type", "authorization_code"),
                new KeyValuePair<string, string>("scope", "499b84ac-1321-427f-aa17-267ca6975798/user_impersonation")
            });

            var tokenResponse = await httpClient.PostAsync(
                $"https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token",
                tokenRequestContent,
                cancellationToken);
            var tokenResponseContent = await tokenResponse.Content.ReadAsStringAsync(cancellationToken);

            if (!tokenResponse.IsSuccessStatusCode)
            {
                _logger.LogError("Azure DevOps token exchange failed: {StatusCode} - {Response}", tokenResponse.StatusCode, tokenResponseContent);
                return BadRequest(new { message = "Failed to exchange authorization code" });
            }

            var tokenData = System.Text.Json.JsonDocument.Parse(tokenResponseContent);
            var accessToken = tokenData.RootElement.GetProperty("access_token").GetString();
            var refreshToken = tokenData.RootElement.TryGetProperty("refresh_token", out var refreshElement) ? refreshElement.GetString() : null;

            if (string.IsNullOrWhiteSpace(accessToken))
            {
                return BadRequest(new { message = "Failed to parse access token" });
            }

            // Get Azure DevOps user profile
            httpClient.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);
            var profileResponse = await httpClient.GetAsync("https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=6.0", cancellationToken);
            var profileContent = await profileResponse.Content.ReadAsStringAsync(cancellationToken);

            if (!profileResponse.IsSuccessStatusCode)
            {
                return BadRequest(new { message = "Failed to get Azure DevOps profile" });
            }

            var profileData = System.Text.Json.JsonDocument.Parse(profileContent);
            var azureDevOpsUserId = profileData.RootElement.GetProperty("id").GetString() ?? "";
            var displayName = profileData.RootElement.TryGetProperty("displayName", out var displayElement) ? displayElement.GetString() : null;

            // Check if this provider is already linked to another user
            var existingLink = await _linkedProviderRepository.GetByProviderUserIdAsync(ProviderTypes.AzureDevOps, azureDevOpsUserId, cancellationToken);
            if (existingLink != null && existingLink.UserId != userId.Value)
            {
                return Conflict(new { message = "This Azure DevOps account is already linked to another user" });
            }

            // Check if user already has Azure DevOps linked
            var userLink = await _linkedProviderRepository.GetByUserAndProviderAsync(userId.Value, ProviderTypes.AzureDevOps, cancellationToken);
            if (userLink != null)
            {
                userLink.UpdateToken(accessToken, refreshToken);
                userLink.UpdateProviderUsername(displayName);
                await _linkedProviderRepository.UpdateAsync(userLink, cancellationToken);
            }
            else
            {
                var linkedProvider = new LinkedProvider(
                    userId.Value,
                    ProviderTypes.AzureDevOps,
                    azureDevOpsUserId,
                    accessToken,
                    displayName,
                    refreshToken
                );
                await _linkedProviderRepository.AddAsync(linkedProvider, cancellationToken);
            }

            _logger.LogInformation("User {UserId} linked Azure DevOps account: {DisplayName}", userId, displayName);

            return Ok(new { message = "Azure DevOps account linked successfully", username = displayName });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error linking Azure DevOps account");
            return BadRequest(new { message = $"Error linking Azure DevOps account: {ex.Message}" });
        }
    }

    /// <summary>
    /// Unlink a provider from current user's account
    /// </summary>
    [HttpDelete("unlink/{provider}")]
    [Authorize]
    public async Task<IActionResult> UnlinkProvider(string provider, CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        // Normalize provider name
        var normalizedProvider = provider.ToLower() switch
        {
            "github" => ProviderTypes.GitHub,
            "microsoft" => ProviderTypes.Microsoft,
            "azuredevops" or "azure-devops" => ProviderTypes.AzureDevOps,
            _ => provider
        };

        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId.Value, normalizedProvider, cancellationToken);
        if (linkedProvider == null)
        {
            return NotFound(new { message = $"Provider {provider} is not linked to your account" });
        }

        await _linkedProviderRepository.DeleteAsync(linkedProvider.Id, cancellationToken);

        // Clear legacy fields if GitHub
        if (normalizedProvider == ProviderTypes.GitHub)
        {
            var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
            if (user != null)
            {
                user.UpdateGitHubToken(null);
                user.UpdateGitHubUsername(null);
                await _userRepository.UpdateAsync(user, cancellationToken);
            }
        }

        _logger.LogInformation("User {UserId} unlinked provider: {Provider}", userId, normalizedProvider);

        return Ok(new { message = $"{provider} account unlinked successfully" });
    }

    /// <summary>
    /// Get authorization URL for linking Azure DevOps (via Microsoft Entra ID)
    /// Azure DevOps now uses Microsoft Entra ID for OAuth - the same app registration as Microsoft login
    /// but with Azure DevOps API scopes
    /// </summary>
    [HttpGet("link/azure-devops/authorize")]
    [Authorize]
    public IActionResult GetAzureDevOpsLinkAuthorizationUrl()
    {
        // Use Microsoft app registration - Azure DevOps now requires Entra ID
        var clientId = _configuration["Microsoft:ClientId"] ?? throw new InvalidOperationException("Microsoft:ClientId not configured");
        var tenantId = _configuration["Microsoft:TenantId"] ?? "common";
        var redirectUri = _configuration["AzureDevOps:RedirectUri"] ?? "http://localhost:4200/auth/callback/azure-devops";
        
        // Azure DevOps API scope - 499b84ac-1321-427f-aa17-267ca6975798 is the Azure DevOps resource ID
        // user_impersonation allows acting on behalf of the user
        var scope = "499b84ac-1321-427f-aa17-267ca6975798/user_impersonation";
        
        // Generate a random state for CSRF protection
        var state = Guid.NewGuid().ToString("N");
        
        // Use Microsoft Entra ID OAuth endpoint
        var authUrl = $"https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize" +
            $"?client_id={Uri.EscapeDataString(clientId)}" +
            $"&response_type=code" +
            $"&redirect_uri={Uri.EscapeDataString(redirectUri)}" +
            $"&scope={Uri.EscapeDataString(scope)}" +
            $"&response_mode=query" +
            $"&state={state}";
        
        _logger.LogInformation("Azure DevOps OAuth URL generated via Entra ID. Redirect URI: {RedirectUri}", redirectUri);
        
        return Ok(new { authorizationUrl = authUrl });
    }

    /// <summary>
    /// Get authorization URL for linking GitHub (when already logged in)
    /// </summary>
    [HttpGet("link/github/authorize")]
    [Authorize]
    public IActionResult GetGitHubLinkAuthorizationUrl()
    {
        var clientId = _configuration["GitHub:ClientId"] ?? throw new InvalidOperationException("GitHub:ClientId not configured");
        var redirectUri = _configuration["GitHub:RedirectUri"] ?? "http://localhost:4200/auth/callback";
        
        // Add link=true to state to indicate this is a link operation
        var authUrl = $"https://github.com/login/oauth/authorize?client_id={Uri.EscapeDataString(clientId)}&redirect_uri={Uri.EscapeDataString(redirectUri)}&scope=repo&state=link";
        
        return Ok(new { authorizationUrl = authUrl });
    }

    /// <summary>
    /// Helper to get current user ID from JWT claims
    /// </summary>
    private Guid? GetCurrentUserId()
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(userIdClaim, out var userId) ? userId : null;
    }

    #endregion

    #region DTOs

    /// <summary>
    /// Request body for user registration
    /// </summary>
    public class RegisterRequest
    {
        public required string Email { get; set; }
        public required string Password { get; set; }
        public string? Name { get; set; }
    }

    /// <summary>
    /// Request body for email/password login
    /// </summary>
    public class LoginRequest
    {
        public required string Email { get; set; }
        public required string Password { get; set; }
    }

    /// <summary>
    /// Request body for GitHub OAuth callback
    /// </summary>
    public class GitHubCallbackRequest
    {
        public required string Code { get; set; }
        public string? State { get; set; }
    }

    /// <summary>
    /// Request body for Microsoft OAuth callback
    /// </summary>
    public class MicrosoftCallbackRequest
    {
        public required string Code { get; set; }
        public string? State { get; set; }
    }

    /// <summary>
    /// Authentication response with token and user info
    /// </summary>
    public class AuthResponse
    {
        public required string Token { get; set; }
        public required UserDto User { get; set; }
    }

    /// <summary>
    /// User data transfer object
    /// </summary>
    public class UserDto
    {
        public Guid Id { get; set; }
        public required string Email { get; set; }
        public string? Name { get; set; }
        public bool EmailVerified { get; set; }
        public string? GitHubUsername { get; set; }
    }

    /// <summary>
    /// Linked provider data transfer object
    /// </summary>
    public class LinkedProviderDto
    {
        public Guid Id { get; set; }
        public required string Provider { get; set; }
        public string? ProviderUsername { get; set; }
        public DateTime LinkedAt { get; set; }
    }

    /// <summary>
    /// Request body for linking a provider
    /// </summary>
    public class LinkProviderRequest
    {
        public required string Code { get; set; }
        public string? RedirectUri { get; set; }
    }

    #endregion

    #region Provider Settings (PAT Management)

    /// <summary>
    /// Get provider settings for the current user
    /// </summary>
    [HttpGet("settings/providers")]
    [Authorize]
    public async Task<IActionResult> GetProviderSettings(CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null)
            return NotFound("User not found");

        return Ok(new ProviderSettingsDto
        {
            AzureDevOpsOrganization = user.AzureDevOpsOrganization,
            HasAzureDevOpsPat = !string.IsNullOrEmpty(user.AzureDevOpsAccessToken),
            HasGitHubPat = !string.IsNullOrEmpty(user.GitHubAccessToken)
        });
    }

    /// <summary>
    /// Save Azure DevOps settings (organization and PAT)
    /// </summary>
    [HttpPost("settings/azure-devops")]
    [Authorize]
    public async Task<IActionResult> SaveAzureDevOpsSettings([FromBody] AzureDevOpsSettingsRequest request, CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null)
            return NotFound("User not found");

        _logger.LogInformation("Saving Azure DevOps settings for user {UserId}: Org={Org}, HasPAT={HasPat}", 
            userId, request.Organization ?? "null", !string.IsNullOrEmpty(request.PersonalAccessToken));

        user.UpdateAzureDevOpsSettings(request.Organization, request.PersonalAccessToken);
        await _userRepository.UpdateAsync(user, cancellationToken);

        _logger.LogInformation("User {UserId} Azure DevOps settings saved. User now has PAT: {HasPat}", 
            userId, !string.IsNullOrEmpty(user.AzureDevOpsAccessToken));
        return Ok(new { message = "Azure DevOps settings saved successfully" });
    }

    /// <summary>
    /// Save GitHub PAT settings
    /// </summary>
    [HttpPost("settings/github")]
    [Authorize]
    public async Task<IActionResult> SaveGitHubSettings([FromBody] GitHubSettingsRequest request, CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null)
            return NotFound("User not found");

        user.UpdateGitHubToken(request.PersonalAccessToken);
        await _userRepository.UpdateAsync(user, cancellationToken);

        _logger.LogInformation("User {UserId} updated GitHub settings", userId);
        return Ok(new { message = "GitHub settings saved successfully" });
    }

    /// <summary>
    /// Clear Azure DevOps settings
    /// </summary>
    [HttpDelete("settings/azure-devops")]
    [Authorize]
    public async Task<IActionResult> ClearAzureDevOpsSettings(CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null)
            return NotFound("User not found");

        user.UpdateAzureDevOpsSettings(null, null);
        await _userRepository.UpdateAsync(user, cancellationToken);

        _logger.LogInformation("User {UserId} cleared Azure DevOps settings", userId);
        return Ok(new { message = "Azure DevOps settings cleared" });
    }

    /// <summary>
    /// Clear GitHub PAT settings
    /// </summary>
    [HttpDelete("settings/github")]
    [Authorize]
    public async Task<IActionResult> ClearGitHubSettings(CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null)
            return NotFound("User not found");

        user.UpdateGitHubToken(null);
        await _userRepository.UpdateAsync(user, cancellationToken);

        _logger.LogInformation("User {UserId} cleared GitHub settings", userId);
        return Ok(new { message = "GitHub settings cleared" });
    }

    /// <summary>
    /// Provider settings response
    /// </summary>
    public class ProviderSettingsDto
    {
        public string? AzureDevOpsOrganization { get; set; }
        public bool HasAzureDevOpsPat { get; set; }
        public bool HasGitHubPat { get; set; }
    }

    /// <summary>
    /// Azure DevOps settings request
    /// </summary>
    public class AzureDevOpsSettingsRequest
    {
        public string? Organization { get; set; }
        public string? PersonalAccessToken { get; set; }
    }

    /// <summary>
    /// GitHub settings request
    /// </summary>
    public class GitHubSettingsRequest
    {
        public string? PersonalAccessToken { get; set; }
    }

    #endregion

    #region AI Configuration

    /// <summary>
    /// Get AI configuration for the current user
    /// </summary>
    [HttpGet("settings/ai")]
    [Authorize]
    public async Task<IActionResult> GetAiSettings(CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null)
            return NotFound("User not found");

        return Ok(new AiSettingsDto
        {
            Provider = user.AiProvider,
            HasApiKey = !string.IsNullOrEmpty(user.AiApiKey),
            Model = user.AiModel,
            BaseUrl = user.AiBaseUrl
        });
    }

    /// <summary>
    /// Save AI configuration
    /// </summary>
    [HttpPost("settings/ai")]
    [Authorize]
    public async Task<IActionResult> SaveAiSettings([FromBody] AiSettingsRequest request, CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null)
            return NotFound("User not found");

        _logger.LogInformation("Saving AI settings for user {UserId}: Provider={Provider}, Model={Model}, HasApiKey={HasKey}", 
            userId, request.Provider ?? "null", request.Model ?? "null", !string.IsNullOrEmpty(request.ApiKey));

        user.UpdateAiSettings(request.Provider, request.ApiKey, request.Model, request.BaseUrl);
        await _userRepository.UpdateAsync(user, cancellationToken);

        return Ok(new { message = "AI settings saved successfully" });
    }

    /// <summary>
    /// Clear AI configuration
    /// </summary>
    [HttpDelete("settings/ai")]
    [Authorize]
    public async Task<IActionResult> ClearAiSettings(CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null)
            return NotFound("User not found");

        user.ClearAiSettings();
        await _userRepository.UpdateAsync(user, cancellationToken);

        _logger.LogInformation("User {UserId} cleared AI settings", userId);
        return Ok(new { message = "AI settings cleared" });
    }

    /// <summary>
    /// Get AI configuration with API key (for sandbox creation)
    /// </summary>
    [HttpGet("settings/ai/full")]
    [Authorize]
    public async Task<IActionResult> GetFullAiSettings(CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null)
            return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null)
            return NotFound("User not found");

        return Ok(new AiSettingsFullDto
        {
            Provider = user.AiProvider ?? "openai",
            ApiKey = user.AiApiKey,
            Model = user.AiModel ?? "gpt-4",
            BaseUrl = user.AiBaseUrl
        });
    }

    /// <summary>
    /// AI settings response (without sensitive data)
    /// </summary>
    public class AiSettingsDto
    {
        public string? Provider { get; set; }
        public bool HasApiKey { get; set; }
        public string? Model { get; set; }
        public string? BaseUrl { get; set; }
    }

    /// <summary>
    /// AI settings response with API key (for internal use)
    /// </summary>
    public class AiSettingsFullDto
    {
        public required string Provider { get; set; }
        public string? ApiKey { get; set; }
        public required string Model { get; set; }
        public string? BaseUrl { get; set; }
    }

    /// <summary>
    /// AI settings request
    /// </summary>
    public class AiSettingsRequest
    {
        public string? Provider { get; set; }
        public string? ApiKey { get; set; }
        public string? Model { get; set; }
        public string? BaseUrl { get; set; }
    }

    #endregion
}
