namespace DevPilot.API.Controllers;

using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using DevPilot.Application.Services;
using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using UserEntity = DevPilot.Domain.Entities.User;
using DevPilot.Infrastructure.Auth;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;

/// <summary>
/// Controller for authentication: Email/Password, GitHub OAuth, OIDC providers (Azure AD, Duende, etc.).
/// Uses <see cref="AuthProviderRegistry"/> so providers can be enabled/disabled via configuration.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class AuthController : ControllerBase
{
    private readonly IUserRepository _userRepository;
    private readonly ILinkedProviderRepository _linkedProviderRepository;
    private readonly ILlmSettingRepository _llmSettingRepository;
    private readonly IEffectiveAiConfigResolver _effectiveAiConfigResolver;
    private readonly AuthenticationService _authenticationService;
    private readonly AuthProviderRegistry _providerRegistry;
    private readonly IMediator _mediator;
    private readonly ILogger<AuthController> _logger;
    private readonly IMemoryCache _memoryCache;
    private readonly IConfiguration _configuration;

    public AuthController(
        IUserRepository userRepository,
        ILinkedProviderRepository linkedProviderRepository,
        ILlmSettingRepository llmSettingRepository,
        IEffectiveAiConfigResolver effectiveAiConfigResolver,
        AuthenticationService authenticationService,
        AuthProviderRegistry providerRegistry,
        IMediator mediator,
        ILogger<AuthController> logger,
        IMemoryCache memoryCache,
        IConfiguration configuration)
    {
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
        _linkedProviderRepository = linkedProviderRepository ?? throw new ArgumentNullException(nameof(linkedProviderRepository));
        _llmSettingRepository = llmSettingRepository ?? throw new ArgumentNullException(nameof(llmSettingRepository));
        _effectiveAiConfigResolver = effectiveAiConfigResolver ?? throw new ArgumentNullException(nameof(effectiveAiConfigResolver));
        _authenticationService = authenticationService ?? throw new ArgumentNullException(nameof(authenticationService));
        _providerRegistry = providerRegistry ?? throw new ArgumentNullException(nameof(providerRegistry));
        _mediator = mediator ?? throw new ArgumentNullException(nameof(mediator));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _memoryCache = memoryCache ?? throw new ArgumentNullException(nameof(memoryCache));
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
    }

    #region Provider Configuration (public)

    /// <summary>
    /// Returns the list of enabled auth providers with frontend-safe configuration.
    /// No secrets are exposed. Frontend uses this to know which login/link buttons to show
    /// and to configure the OIDC library dynamically.
    /// </summary>
    [HttpGet("config")]
    public IActionResult GetAuthConfig()
    {
        var options = _providerRegistry.Options;
        var providers = new List<object>();

        foreach (var (name, config) in options.GetEnabledProviders())
        {
            var type = config.Type ?? "Local";

            switch (type.ToLowerInvariant())
            {
                case "local":
                    providers.Add(new { name, type });
                    break;

                case "backendoauth":
                    // Build authorization URL via the provider
                    string? authUrl = null;
                    if (_providerRegistry.TryGetProvider(name, out var bp) && bp != null)
                        authUrl = bp.BuildAuthorizationUrl();

                    providers.Add(new
                    {
                        name,
                        type,
                        clientId = config.ClientId,
                        redirectUri = config.RedirectUri,
                        authorizationUrl = authUrl
                    });
                    break;

                case "frontendoidc":
                    // Send the SPA (public) client ID to the frontend;
                    // fall back to ClientId if SpaClientId is not configured.
                    var frontendClientId = !string.IsNullOrEmpty(config.SpaClientId)
                        ? config.SpaClientId
                        : config.ClientId;

                    providers.Add(new
                    {
                        name,
                        type,
                        authority = config.Authority,
                        clientId = frontendClientId,
                        scopes = config.Scopes,
                        tenantId = config.TenantId
                    });
                    break;
            }
        }

        return Ok(new { providers });
    }

    #endregion

    #region Email/Password Authentication

    /// <summary>
    /// Register a new user with email and password
    /// </summary>
    [HttpPost("register")]
    public async Task<IActionResult> Register([FromBody] RegisterRequest request, CancellationToken cancellationToken)
    {
        if (!_providerRegistry.IsEnabled("Local"))
            return BadRequest(new { message = "Local authentication is disabled" });

        if (string.IsNullOrWhiteSpace(request.Email))
            return BadRequest(new { message = "Email is required" });

        if (string.IsNullOrWhiteSpace(request.Password))
            return BadRequest(new { message = "Password is required" });

        if (!new EmailAddressAttribute().IsValid(request.Email))
            return BadRequest(new { message = "Invalid email format" });

        var (isValid, errorMessage) = _authenticationService.ValidatePassword(request.Password);
        if (!isValid)
            return BadRequest(new { message = errorMessage });

        try
        {
            var existingUser = await _userRepository.GetByEmailAsync(request.Email, cancellationToken);
            if (existingUser != null)
                return Conflict(new { message = "A user with this email already exists" });

            var passwordHash = _authenticationService.HashPassword(request.Password);
            var user = UserEntity.CreateWithPassword(request.Email, passwordHash, request.Name);
            await _userRepository.AddAsync(user, cancellationToken);

            var jwtToken = _authenticationService.GenerateToken(user.Id, user.Email, IsAdminEmail(user.Email));
            _logger.LogInformation("New user registered: {Email}", request.Email);

            return Ok(new AuthResponse
            {
                Token = jwtToken,
                User = MapUserDto(user)
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
        if (!_providerRegistry.IsEnabled("Local"))
            return BadRequest(new { message = "Local authentication is disabled" });

        if (string.IsNullOrWhiteSpace(request.Email) || string.IsNullOrWhiteSpace(request.Password))
            return BadRequest(new { message = "Email and password are required" });

        try
        {
            var user = await _userRepository.GetByEmailAsync(request.Email, cancellationToken);
            if (user == null)
                return Unauthorized(new { message = "Invalid email or password" });

            if (!user.HasPassword())
                return BadRequest(new { message = "This account uses social login. Please sign in with an external provider." });

            if (!_authenticationService.VerifyPassword(request.Password, user.PasswordHash!))
                return Unauthorized(new { message = "Invalid email or password" });

            var jwtToken = _authenticationService.GenerateToken(user.Id, user.Email, IsAdminEmail(user.Email));
            _logger.LogInformation("User logged in: {Email}", request.Email);

            return Ok(new AuthResponse
            {
                Token = jwtToken,
                User = MapUserDto(user)
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during login for {Email}", request.Email);
            return StatusCode(500, new { message = "An error occurred during login" });
        }
    }

    #endregion

    #region Generic Provider OAuth – Login

    /// <summary>
    /// Get authorization URL for a BackendOAuth provider (e.g. GitHub).
    /// </summary>
    [HttpGet("{provider}/authorize")]
    public IActionResult GetAuthorizationUrl(string provider)
    {
        if (!_providerRegistry.TryGetProvider(provider, out var authProvider) || authProvider == null)
            return NotFound(new { message = $"Provider '{provider}' is not enabled" });

        if (authProvider.Type != "BackendOAuth")
            return BadRequest(new { message = $"Provider '{provider}' uses frontend OIDC. Use the OIDC library to initiate login." });

        var url = authProvider.BuildAuthorizationUrl();
        if (url == null)
            return BadRequest(new { message = $"Provider '{provider}' does not support authorization URLs" });

        return Ok(new { authorizationUrl = url });
    }

    /// <summary>
    /// Handle OAuth callback for a BackendOAuth provider (e.g. GitHub). Exchanges code for token, creates/finds user, returns JWT.
    /// </summary>
    [HttpPost("{provider}/callback")]
    public async Task<IActionResult> OAuthCallback(string provider, [FromBody] CodeCallbackRequest request, CancellationToken cancellationToken)
    {
        if (!_providerRegistry.TryGetProvider(provider, out var authProvider) || authProvider == null)
            return NotFound(new { message = $"Provider '{provider}' is not enabled" });

        if (authProvider.Type != "BackendOAuth")
            return BadRequest(new { message = $"Provider '{provider}' does not support code exchange. Use POST {provider}/token instead." });

        if (string.IsNullOrWhiteSpace(request.Code))
            return BadRequest(new { message = "Authorization code is required" });

        // Return cached response if we already successfully exchanged this code (avoids "bad_verification_code" on duplicate requests).
        var cacheKey = $"oauth_callback:{provider}:{request.Code}";
        if (_memoryCache.TryGetValue(cacheKey, out AuthResponse? cachedResponse) && cachedResponse != null)
        {
            _logger.LogDebug("Returning cached OAuth callback result for {Provider}", provider);
            return Ok(cachedResponse);
        }

        try
        {
            // Use the same RedirectUri as in the authorize request so GitHub accepts the code exchange.
            var config = _providerRegistry.Options.Providers.GetValueOrDefault(provider);
            var redirectUri = config?.RedirectUri
                ?? throw new InvalidOperationException($"Provider '{provider}' has no RedirectUri configured");

            var tokenResult = await authProvider.ExchangeCodeAsync(request.Code, redirectUri, cancellationToken);
            var profile = await authProvider.GetUserProfileAsync(tokenResult.AccessToken, cancellationToken);

            var email = profile.Email ?? profile.DisplayName ?? profile.ProviderUserId;
            var user = await _userRepository.GetByEmailAsync(email, cancellationToken);

            if (user == null)
            {
                user = new UserEntity(email, profile.DisplayName);
                await _userRepository.AddAsync(user, cancellationToken);
            }

            var providerType = NormalizeProviderType(provider);
            await UpsertLinkedProvider(user.Id, providerType, profile.ProviderUserId, tokenResult.AccessToken,
                profile.DisplayName, tokenResult.RefreshToken, tokenResult.ExpiresAt, cancellationToken, transferIfLinkedToOtherUser: true);

            // Update legacy fields for GitHub backward compatibility
            if (provider.Equals("GitHub", StringComparison.OrdinalIgnoreCase))
            {
                user.UpdateGitHubToken(tokenResult.AccessToken, tokenResult.ExpiresAt);
                user.UpdateGitHubUsername(profile.DisplayName);
                await _userRepository.UpdateAsync(user, cancellationToken);
            }

            var jwtToken = _authenticationService.GenerateToken(user.Id, user.Email, IsAdminEmail(user.Email));
            _logger.LogInformation("User authenticated via {Provider}: {Email}", provider, email);

            var response = new AuthResponse
            {
                Token = jwtToken,
                User = MapUserDto(user)
            };

            _memoryCache.Set(cacheKey, response, TimeSpan.FromSeconds(120));

            return Ok(response);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing {Provider} OAuth callback", provider);
            return BadRequest(new { message = $"Error processing OAuth callback: {ex.Message}" });
        }
    }

    /// <summary>
    /// Handle login with a frontend-obtained token for a FrontendOidc provider (e.g. Azure AD, Duende).
    /// Validates the token, creates/finds user, returns JWT.
    /// </summary>
    [HttpPost("{provider}/token")]
    public async Task<IActionResult> OidcTokenLogin(string provider, [FromBody] TokenRequest request, CancellationToken cancellationToken)
    {
        if (!_providerRegistry.TryGetProvider(provider, out var authProvider) || authProvider == null)
            return NotFound(new { message = $"Provider '{provider}' is not enabled" });

        if (authProvider.Type != "FrontendOidc")
            return BadRequest(new { message = $"Provider '{provider}' does not support token validation. Use POST {provider}/callback instead." });

        // Prefer ID token for authentication; fall back to access token for backward compat
        var tokenToValidate = !string.IsNullOrWhiteSpace(request.IdToken) ? request.IdToken : request.AccessToken;
        if (string.IsNullOrWhiteSpace(tokenToValidate))
            return BadRequest(new { message = "ID token or access token is required" });

        try
        {
            // Validate the ID token (audience = SPA/backend client ID)
            await authProvider.ValidateTokenAsync(tokenToValidate, cancellationToken);

            // For user profile: use access token with ProfileEndpoint if available,
            // otherwise extract claims from the validated token
            var profileToken = !string.IsNullOrWhiteSpace(request.AccessToken) ? request.AccessToken : tokenToValidate;
            var profile = await authProvider.GetUserProfileAsync(profileToken, cancellationToken);

            var email = profile.Email ?? profile.DisplayName ?? profile.ProviderUserId;
            var user = await _userRepository.GetByEmailAsync(email, cancellationToken);

            if (user == null)
            {
                user = new UserEntity(email, profile.DisplayName);
                await _userRepository.AddAsync(user, cancellationToken);
            }
            else if (string.IsNullOrEmpty(user.Name) && !string.IsNullOrEmpty(profile.DisplayName))
            {
                user.UpdateName(profile.DisplayName);
                await _userRepository.UpdateAsync(user, cancellationToken);
            }

            var jwtToken = _authenticationService.GenerateToken(user.Id, user.Email, IsAdminEmail(user.Email));
            _logger.LogInformation("User authenticated via {Provider} (OIDC token): {Email}", provider, email);

            return Ok(new AuthResponse
            {
                Token = jwtToken,
                User = MapUserDto(user)
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing {Provider} OIDC token login", provider);
            return BadRequest(new { message = ex is ArgumentException ? ex.Message : $"Invalid or expired token: {ex.Message}" });
        }
    }

    #endregion

    #region Generic Provider – Linking

    /// <summary>
    /// Get authorization URL for linking a BackendOAuth provider (when already logged in).
    /// </summary>
    [HttpGet("link/{provider}/authorize")]
    [Authorize]
    public IActionResult GetLinkAuthorizationUrl(string provider)
    {
        if (!_providerRegistry.TryGetProvider(provider, out var authProvider) || authProvider == null)
            return NotFound(new { message = $"Provider '{provider}' is not enabled" });

        if (authProvider.Type != "BackendOAuth")
            return BadRequest(new { message = $"Provider '{provider}' uses frontend OIDC for linking." });

        var url = authProvider.BuildAuthorizationUrl(state: "link");
        if (url == null)
            return BadRequest(new { message = $"Provider '{provider}' does not support authorization URLs" });

        return Ok(new { authorizationUrl = url });
    }

    /// <summary>
    /// Link an external provider using a backend code exchange (BackendOAuth providers).
    /// </summary>
    [HttpPost("link/{provider}/callback")]
    [Authorize]
    public async Task<IActionResult> LinkWithCode(string provider, [FromBody] CodeCallbackRequest request, CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        if (!_providerRegistry.TryGetProvider(provider, out var authProvider) || authProvider == null)
            return NotFound(new { message = $"Provider '{provider}' is not enabled" });

        if (string.IsNullOrWhiteSpace(request.Code))
            return BadRequest(new { message = "Authorization code is required" });

        try
        {
            var config = _providerRegistry.Options.Providers.GetValueOrDefault(provider);
            var redirectUri = config?.RedirectUri
                ?? throw new InvalidOperationException($"Provider '{provider}' has no RedirectUri configured");

            var tokenResult = await authProvider.ExchangeCodeAsync(request.Code, redirectUri, cancellationToken);
            var profile = await authProvider.GetUserProfileAsync(tokenResult.AccessToken, cancellationToken);

            var providerType = NormalizeProviderType(provider);
            await UpsertLinkedProvider(userId.Value, providerType, profile.ProviderUserId, tokenResult.AccessToken,
                profile.DisplayName, tokenResult.RefreshToken, tokenResult.ExpiresAt, cancellationToken, transferIfLinkedToOtherUser: true);

            // GitHub backward compatibility
            if (provider.Equals("GitHub", StringComparison.OrdinalIgnoreCase))
            {
                var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
                if (user != null)
                {
                    user.UpdateGitHubToken(tokenResult.AccessToken);
                    user.UpdateGitHubUsername(profile.DisplayName);
                    await _userRepository.UpdateAsync(user, cancellationToken);
                }
            }

            _logger.LogInformation("User {UserId} linked {Provider}: {Username}", userId, provider, profile.DisplayName);
            return Ok(new { message = $"{provider} account linked successfully", username = profile.DisplayName });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error linking {Provider} account", provider);
            return BadRequest(new { message = $"Error linking {provider} account: {ex.Message}" });
        }
    }

    /// <summary>
    /// Link an external provider using a frontend-obtained token (FrontendOidc providers).
    /// </summary>
    [HttpPost("link/{provider}/token")]
    [Authorize]
    public async Task<IActionResult> LinkWithToken(string provider, [FromBody] TokenRequest request, CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        if (!_providerRegistry.TryGetProvider(provider, out var authProvider) || authProvider == null)
            return NotFound(new { message = $"Provider '{provider}' is not enabled" });

        // Prefer ID token for validation; fall back to access token
        var tokenToValidate = !string.IsNullOrWhiteSpace(request.IdToken) ? request.IdToken : request.AccessToken;
        if (string.IsNullOrWhiteSpace(tokenToValidate))
            return BadRequest(new { message = "ID token or access token is required" });

        try
        {
            await authProvider.ValidateTokenAsync(tokenToValidate, cancellationToken);

            var profileToken = !string.IsNullOrWhiteSpace(request.AccessToken) ? request.AccessToken : tokenToValidate;
            var profile = await authProvider.GetUserProfileAsync(profileToken, cancellationToken);

            var providerType = NormalizeProviderType(provider);
            await UpsertLinkedProvider(userId.Value, providerType, profile.ProviderUserId, request.AccessToken ?? tokenToValidate,
                profile.DisplayName, null, null, cancellationToken, transferIfLinkedToOtherUser: true);

            _logger.LogInformation("User {UserId} linked {Provider} via token: {Username}", userId, provider, profile.DisplayName);
            return Ok(new { message = $"{provider} account linked successfully", username = profile.DisplayName });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error linking {Provider} account with token", provider);
            return BadRequest(new { message = ex is ArgumentException ? ex.Message : $"Invalid or expired token: {ex.Message}" });
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
        if (userId == null) return Unauthorized();

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
    /// Unlink a provider from current user's account
    /// </summary>
    [HttpDelete("unlink/{provider}")]
    [Authorize]
    public async Task<IActionResult> UnlinkProvider(string provider, CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var normalizedProvider = NormalizeProviderType(provider);
        var linkedProvider = await _linkedProviderRepository.GetByUserAndProviderAsync(userId.Value, normalizedProvider, cancellationToken);
        if (linkedProvider == null)
            return NotFound(new { message = $"Provider {provider} is not linked to your account" });

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

    #endregion

    #region Provider Settings (PAT Management)

    [HttpGet("settings/providers")]
    [Authorize]
    public async Task<IActionResult> GetProviderSettings(CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null) return NotFound("User not found");

        return Ok(new ProviderSettingsDto
        {
            AzureDevOpsOrganization = user.AzureDevOpsOrganization,
            HasAzureDevOpsPat = !string.IsNullOrEmpty(user.AzureDevOpsAccessToken),
            HasGitHubPat = !string.IsNullOrEmpty(user.GitHubAccessToken)
        });
    }

    [HttpPost("settings/azure-devops")]
    [Authorize]
    public async Task<IActionResult> SaveAzureDevOpsSettings([FromBody] AzureDevOpsSettingsRequest request, CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null) return NotFound("User not found");

        user.UpdateAzureDevOpsSettings(request.Organization, request.PersonalAccessToken);
        await _userRepository.UpdateAsync(user, cancellationToken);

        return Ok(new { message = "Azure DevOps settings saved successfully" });
    }

    [HttpPost("settings/github")]
    [Authorize]
    public async Task<IActionResult> SaveGitHubSettings([FromBody] GitHubSettingsRequest request, CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null) return NotFound("User not found");

        user.UpdateGitHubToken(request.PersonalAccessToken);
        await _userRepository.UpdateAsync(user, cancellationToken);

        return Ok(new { message = "GitHub settings saved successfully" });
    }

    [HttpDelete("settings/azure-devops")]
    [Authorize]
    public async Task<IActionResult> ClearAzureDevOpsSettings(CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null) return NotFound("User not found");

        user.ClearAzureDevOpsSettings();
        await _userRepository.UpdateAsync(user, cancellationToken);

        return Ok(new { message = "Azure DevOps settings cleared" });
    }

    [HttpDelete("settings/github")]
    [Authorize]
    public async Task<IActionResult> ClearGitHubSettings(CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
        if (user == null) return NotFound("User not found");

        user.UpdateGitHubToken(null);
        await _userRepository.UpdateAsync(user, cancellationToken);

        return Ok(new { message = "GitHub settings cleared" });
    }

    #endregion

    #region AI Configuration (from LLM providers only)

    [HttpGet("settings/ai")]
    [Authorize]
    public async Task<IActionResult> GetAiSettings(CancellationToken cancellationToken)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var defaultLlm = await _llmSettingRepository.GetDefaultByUserIdAsync(userId.Value, cancellationToken);
        if (defaultLlm == null)
        {
            return Ok(new AiSettingsDto
            {
                Provider = "openai",
                HasApiKey = false,
                Model = "gpt-4o",
                BaseUrl = null
            });
        }

        return Ok(new AiSettingsDto
        {
            Provider = defaultLlm.Provider,
            HasApiKey = !string.IsNullOrEmpty(defaultLlm.ApiKey),
            Model = defaultLlm.Model,
            BaseUrl = defaultLlm.BaseUrl
        });
    }

    [HttpGet("settings/ai/full")]
    [Authorize]
    public async Task<IActionResult> GetFullAiSettings([FromQuery] Guid? repositoryId, CancellationToken cancellationToken = default)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var config = await _effectiveAiConfigResolver.GetEffectiveConfigAsync(userId.Value, repositoryId, cancellationToken);
        return Ok(new AiSettingsFullDto
        {
            Provider = config.Provider,
            ApiKey = config.ApiKey,
            Model = config.Model,
            BaseUrl = config.BaseUrl
        });
    }

    #endregion

    #region LLM Settings (multiple configs + default)

    [HttpGet("settings/llm")]
    [Authorize]
    public async Task<IActionResult> GetLlmSettings(CancellationToken cancellationToken = default)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var personal = await _llmSettingRepository.GetByUserIdAsync(userId.Value, cancellationToken);
        var shared   = await _llmSettingRepository.GetSharedAsync(cancellationToken);

        // Fetch the user to know their preferred shared LLM
        var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);

        var result = personal.Select(s => new LlmSettingDto
        {
            Id = s.Id, Name = s.Name, Provider = s.Provider, Model = s.Model,
            BaseUrl = s.BaseUrl, IsDefault = s.IsDefault,
            HasApiKey = !string.IsNullOrEmpty(s.ApiKey), IsShared = false
        })
        .Concat(shared.Select(s => new LlmSettingDto
        {
            Id = s.Id, Name = s.Name, Provider = s.Provider, Model = s.Model,
            BaseUrl = s.BaseUrl,
            // A shared provider is "default" for this user if they've chosen it as their preferred shared LLM
            IsDefault = user?.PreferredSharedLlmSettingId == s.Id,
            HasApiKey = !string.IsNullOrEmpty(s.ApiKey), IsShared = true
        }))
        .ToList();

        return Ok(result);
    }

    [HttpPost("settings/llm")]
    [Authorize]
    public async Task<IActionResult> CreateLlmSetting([FromBody] CreateLlmSettingRequest request, CancellationToken cancellationToken = default)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var entity = new LlmSetting(
            userId.Value,
            request.Name ?? "Unnamed",
            request.Provider ?? "openai",
            request.ApiKey,
            request.Model ?? "gpt-4o",
            request.BaseUrl,
            request.IsDefault);
        entity = await _llmSettingRepository.AddAsync(entity, cancellationToken);
        return Ok(new LlmSettingDto
        {
            Id = entity.Id,
            Name = entity.Name,
            Provider = entity.Provider,
            Model = entity.Model,
            BaseUrl = entity.BaseUrl,
            IsDefault = entity.IsDefault,
            HasApiKey = !string.IsNullOrEmpty(entity.ApiKey)
        });
    }

    [HttpPatch("settings/llm/{id:guid}")]
    [Authorize]
    public async Task<IActionResult> UpdateLlmSetting(Guid id, [FromBody] UpdateLlmSettingRequest request, CancellationToken cancellationToken = default)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var entity = await _llmSettingRepository.GetByIdAsync(id, cancellationToken);
        if (entity == null || entity.UserId != userId.Value) return NotFound();

        entity.Update(
            request.Name,
            request.ApiKey,
            request.Model,
            request.BaseUrl,
            request.Provider);
        if (request.IsDefault.HasValue) entity.SetDefault(request.IsDefault.Value);
        await _llmSettingRepository.UpdateAsync(entity, cancellationToken);
        return Ok(new LlmSettingDto
        {
            Id = entity.Id,
            Name = entity.Name,
            Provider = entity.Provider,
            Model = entity.Model,
            BaseUrl = entity.BaseUrl,
            IsDefault = entity.IsDefault,
            HasApiKey = !string.IsNullOrEmpty(entity.ApiKey)
        });
    }

    [HttpDelete("settings/llm/{id:guid}")]
    [Authorize]
    public async Task<IActionResult> DeleteLlmSetting(Guid id, CancellationToken cancellationToken = default)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var entity = await _llmSettingRepository.GetByIdAsync(id, cancellationToken);
        if (entity == null || entity.UserId != userId.Value) return NotFound();

        await _llmSettingRepository.DeleteAsync(id, cancellationToken);
        return Ok(new { message = "LLM setting deleted" });
    }

    [HttpPost("settings/llm/{id:guid}/set-default")]
    [Authorize]
    public async Task<IActionResult> SetDefaultLlmSetting(Guid id, CancellationToken cancellationToken = default)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        var entity = await _llmSettingRepository.GetByIdAsync(id, cancellationToken);
        if (entity == null) return NotFound();

        if (entity.IsShared)
        {
            // For shared providers: store the user's preference on their profile
            var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
            if (user == null) return Unauthorized();
            // Clear any personal default so the shared one is used by the resolver
            await _llmSettingRepository.UnsetDefaultForUserAsync(userId.Value, cancellationToken);
            user.SetPreferredSharedLlm(id);
            await _userRepository.UpdateAsync(user, cancellationToken);
        }
        else
        {
            // Personal provider: must own it
            if (entity.UserId != userId.Value) return NotFound();
            // Clear any preferred shared LLM so the personal default takes over
            var user = await _userRepository.GetByIdAsync(userId.Value, cancellationToken);
            if (user != null && user.PreferredSharedLlmSettingId.HasValue)
            {
                user.SetPreferredSharedLlm(null);
                await _userRepository.UpdateAsync(user, cancellationToken);
            }
            entity.SetDefault(true);
            await _llmSettingRepository.UpdateAsync(entity, cancellationToken);
        }

        return Ok(new { message = "Default LLM setting updated" });
    }

    #region Admin — shared LLM provider management

    [HttpGet("admin/llm")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> AdminGetSharedLlmSettings(CancellationToken cancellationToken = default)
    {
        var list = await _llmSettingRepository.GetSharedAsync(cancellationToken);
        return Ok(list.Select(s => new LlmSettingDto
        {
            Id = s.Id, Name = s.Name, Provider = s.Provider, Model = s.Model,
            BaseUrl = s.BaseUrl, IsDefault = false,
            HasApiKey = !string.IsNullOrEmpty(s.ApiKey), IsShared = true
        }).ToList());
    }

    [HttpPost("admin/llm")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> AdminCreateSharedLlmSetting([FromBody] CreateLlmSettingRequest request, CancellationToken cancellationToken = default)
    {
        var entity = LlmSetting.CreateShared(
            request.Name ?? "Unnamed",
            request.Provider ?? "openai",
            request.ApiKey,
            request.Model ?? "gpt-4o",
            request.BaseUrl);
        entity = await _llmSettingRepository.AddAsync(entity, cancellationToken);
        return Ok(new LlmSettingDto
        {
            Id = entity.Id, Name = entity.Name, Provider = entity.Provider, Model = entity.Model,
            BaseUrl = entity.BaseUrl, IsDefault = false,
            HasApiKey = !string.IsNullOrEmpty(entity.ApiKey), IsShared = true
        });
    }

    [HttpPatch("admin/llm/{id:guid}")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> AdminUpdateSharedLlmSetting(Guid id, [FromBody] UpdateLlmSettingRequest request, CancellationToken cancellationToken = default)
    {
        var entity = await _llmSettingRepository.GetByIdAsync(id, cancellationToken);
        if (entity == null || !entity.IsShared) return NotFound();

        entity.Update(request.Name, request.ApiKey, request.Model, request.BaseUrl, request.Provider);
        await _llmSettingRepository.UpdateAsync(entity, cancellationToken);
        return Ok(new LlmSettingDto
        {
            Id = entity.Id, Name = entity.Name, Provider = entity.Provider, Model = entity.Model,
            BaseUrl = entity.BaseUrl, IsDefault = false,
            HasApiKey = !string.IsNullOrEmpty(entity.ApiKey), IsShared = true
        });
    }

    [HttpDelete("admin/llm/{id:guid}")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> AdminDeleteSharedLlmSetting(Guid id, CancellationToken cancellationToken = default)
    {
        var entity = await _llmSettingRepository.GetByIdAsync(id, cancellationToken);
        if (entity == null || !entity.IsShared) return NotFound();
        await _llmSettingRepository.DeleteAsync(id, cancellationToken);
        return Ok(new { message = "Shared LLM setting deleted" });
    }

    #endregion

    #endregion

    #region Helpers

    private Guid? GetCurrentUserId()
    {
        var claim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(claim, out var id) ? id : null;
    }

    private bool IsCurrentUserAdmin()
        => User.IsInRole("admin");

    /// <summary>
    /// Returns true when the given email is designated as super-admin via the ADMIN_EMAIL env var / config.
    /// Handles Microsoft Azure AD external users whose email is stored as
    /// "original_email_gmail.com#EXT#@tenant.onmicrosoft.com" — the original email is extracted
    /// by replacing the last underscore before "#EXT#" with "@".
    /// </summary>
    private bool IsAdminEmail(string email)
    {
        var adminEmail = (_configuration["AdminEmail"] ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(adminEmail)) return false;

        var candidate = email.Trim();
        if (string.Equals(adminEmail, candidate, StringComparison.OrdinalIgnoreCase))
            return true;

        // Unwrap Microsoft #EXT# external user format → recover original email
        var extIdx = candidate.IndexOf("#EXT#", StringComparison.OrdinalIgnoreCase);
        if (extIdx > 0)
        {
            var localPart = candidate[..extIdx]; // e.g. "user_gmail.com"
            var lastUnderscore = localPart.LastIndexOf('_');
            if (lastUnderscore > 0)
            {
                var recovered = localPart[..lastUnderscore] + "@" + localPart[(lastUnderscore + 1)..];
                if (string.Equals(adminEmail, recovered, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
        }

        return false;
    }

    private static UserDto MapUserDto(UserEntity user) => new()
    {
        Id = user.Id,
        Email = user.Email,
        Name = user.Name,
        EmailVerified = user.EmailVerified,
        GitHubUsername = user.GitHubUsername
    };

    private static string NormalizeProviderType(string provider) =>
        provider.ToLower() switch
        {
            "github" => ProviderTypes.GitHub,
            "microsoft" or "azuread" => ProviderTypes.Microsoft,
            "azuredevops" or "azure-devops" => ProviderTypes.AzureDevOps,
            _ => provider
        };

    private async System.Threading.Tasks.Task UpsertLinkedProvider(
        Guid userId, string providerType, string providerUserId, string accessToken,
        string? displayName, string? refreshToken, DateTime? expiresAt,
        CancellationToken ct,
        bool transferIfLinkedToOtherUser = false)
    {
        var existingLink = await _linkedProviderRepository.GetByProviderUserIdAsync(providerType, providerUserId, ct);
        if (existingLink != null && existingLink.UserId != userId)
        {
            if (transferIfLinkedToOtherUser)
            {
                await _linkedProviderRepository.DeleteAsync(existingLink.Id, ct);
                existingLink = null;
            }
            else
            {
                throw new InvalidOperationException($"This {providerType} account is already linked to another user");
            }
        }

        var userLink = await _linkedProviderRepository.GetByUserAndProviderAsync(userId, providerType, ct);
        if (userLink != null)
        {
            userLink.UpdateToken(accessToken, refreshToken, expiresAt);
            userLink.UpdateProviderUsername(displayName);
            await _linkedProviderRepository.UpdateAsync(userLink, ct);
        }
        else
        {
            var linked = new LinkedProvider(userId, providerType, providerUserId, accessToken, displayName, refreshToken, expiresAt);
            await _linkedProviderRepository.AddAsync(linked, ct);
        }
    }

    #endregion

    #region DTOs

    public class RegisterRequest
    {
        public required string Email { get; set; }
        public required string Password { get; set; }
        public string? Name { get; set; }
    }

    public class LoginRequest
    {
        public required string Email { get; set; }
        public required string Password { get; set; }
    }

    public class CodeCallbackRequest
    {
        public required string Code { get; set; }
        public string? State { get; set; }
        public string? RedirectUri { get; set; }
    }

    public class TokenRequest
    {
        /// <summary>ID token for authentication validation (audience = SPA client ID).</summary>
        public string? IdToken { get; set; }
        /// <summary>Access token for API calls (e.g. Microsoft Graph /v1.0/me for user profile).</summary>
        public string? AccessToken { get; set; }
    }

    public class AuthResponse
    {
        public required string Token { get; set; }
        public required UserDto User { get; set; }
    }

    public class UserDto
    {
        public Guid Id { get; set; }
        public required string Email { get; set; }
        public string? Name { get; set; }
        public bool EmailVerified { get; set; }
        public string? GitHubUsername { get; set; }
    }

    public class LinkedProviderDto
    {
        public Guid Id { get; set; }
        public required string Provider { get; set; }
        public string? ProviderUsername { get; set; }
        public DateTime LinkedAt { get; set; }
    }

    public class ProviderSettingsDto
    {
        public string? AzureDevOpsOrganization { get; set; }
        public bool HasAzureDevOpsPat { get; set; }
        public bool HasGitHubPat { get; set; }
    }

    public class AzureDevOpsSettingsRequest
    {
        public string? Organization { get; set; }
        public string? PersonalAccessToken { get; set; }
    }

    public class GitHubSettingsRequest
    {
        public string? PersonalAccessToken { get; set; }
    }

    public class AiSettingsDto
    {
        public string? Provider { get; set; }
        public bool HasApiKey { get; set; }
        public string? Model { get; set; }
        public string? BaseUrl { get; set; }
    }

    public class AiSettingsFullDto
    {
        public required string Provider { get; set; }
        public string? ApiKey { get; set; }
        public string? Model { get; set; }
        public string? BaseUrl { get; set; }
    }

    public class LlmSettingDto
    {
        public Guid Id { get; set; }
        public required string Name { get; set; }
        public required string Provider { get; set; }
        public required string Model { get; set; }
        public string? BaseUrl { get; set; }
        public bool IsDefault { get; set; }
        public bool HasApiKey { get; set; }
        /// <summary>True when this is an admin-created shared provider (read-only for regular users).</summary>
        public bool IsShared { get; set; }
    }

    public class CreateLlmSettingRequest
    {
        public string? Name { get; set; }
        public string? Provider { get; set; }
        public string? ApiKey { get; set; }
        public string? Model { get; set; }
        public string? BaseUrl { get; set; }
        public bool IsDefault { get; set; }
    }

    public class UpdateLlmSettingRequest
    {
        public string? Name { get; set; }
        public string? Provider { get; set; }
        public string? ApiKey { get; set; }
        public string? Model { get; set; }
        public string? BaseUrl { get; set; }
        public bool? IsDefault { get; set; }
    }

    #endregion
}
