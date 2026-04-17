import { Injectable, signal, computed } from '@angular/core';
import { Observable, tap, firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthProviderConfig, AuthConfigResponse } from '../auth/oidc-config.loader';

export interface User {
  id: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
  githubUsername?: string;
}

/** Row from GET /users/all (admin only). */
export interface AdminUserListItem {
  id: string;
  email: string;
  name?: string | null;
  /** Effective administrator (app flag or AdminEmail bootstrap). */
  isAdmin: boolean;
  /** Always receives admin role from AdminEmail configuration. */
  isBootstrapAdmin: boolean;
  /** Persisted application-admin flag (editable unless bootstrap). */
  isAppAdmin: boolean;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface LinkedProvider {
  id: string;
  provider: string;
  providerUsername?: string;
  linkedAt: string;
}

/**
 * Generic authentication service.
 *
 * Supports multiple provider types:
 * - Local (email/password)
 * - BackendOAuth (e.g. GitHub – backend exchanges code)
 * - FrontendOidc (e.g. Azure AD, Duende – frontend obtains token via OIDC lib)
 *
 * Provider configuration is fetched once from GET /api/auth/config and cached.
 */
@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly tokenSignal = signal<string | null>(null);
  private readonly userSignal = signal<User | null>(null);
  private readonly isAdminSignal = signal<boolean>(false);

  // Expose readonly signals
  readonly token = this.tokenSignal.asReadonly();
  readonly user = this.userSignal.asReadonly();
  readonly isAuthenticated = signal<boolean>(false);
  /** True when the current JWT contains the "admin" role claim. */
  readonly isAdmin = this.isAdminSignal.asReadonly();

  // Provider config (fetched from backend)
  private readonly _providerConfigs = signal<AuthProviderConfig[]>([]);
  private _configLoaded = false;

  /** All enabled providers from the backend config */
  readonly providerConfigs = this._providerConfigs.asReadonly();

  /** Only enabled providers of a given type */
  readonly localProviders = computed(() => this._providerConfigs().filter(p => p.type === 'Local'));
  readonly backendOAuthProviders = computed(() => this._providerConfigs().filter(p => p.type === 'BackendOAuth'));
  readonly frontendOidcProviders = computed(() => this._providerConfigs().filter(p => p.type === 'FrontendOidc'));
  readonly isLocalEnabled = computed(() => this.localProviders().length > 0);

  constructor(private apiService: ApiService) {
    // Load token from localStorage on init
    const savedToken = localStorage.getItem('auth_token');
    const savedUser = localStorage.getItem('auth_user');
    if (savedToken) {
      this.tokenSignal.set(savedToken);
      this.isAuthenticated.set(true);
      this.isAdminSignal.set(this.decodeIsAdmin(savedToken));
    }
    if (savedUser) {
      try {
        this.userSignal.set(JSON.parse(savedUser));
      } catch (e) {
        console.error('Failed to parse saved user', e);
      }
    }
  }

  /** Decode the JWT payload and check for the "admin" role claim. */
  private decodeIsAdmin(token: string): boolean {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const roles: string | string[] | undefined =
        payload['http://schemas.microsoft.com/ws/2008/06/identity/claims/role'] ??
        payload['role'] ??
        payload['roles'];
      if (Array.isArray(roles)) return roles.includes('admin');
      return roles === 'admin';
    } catch {
      return false;
    }
  }

  // ============================================
  // Provider Config
  // ============================================

  /**
   * Fetch and cache the auth provider config from the backend.
   * Safe to call multiple times – only fetches once.
   */
  async loadProviderConfig(): Promise<AuthProviderConfig[]> {
    if (this._configLoaded) return this._providerConfigs();

    try {
      const response = await firstValueFrom(
        this.apiService.get<AuthConfigResponse>('/auth/config')
      );
      this._providerConfigs.set(response.providers);
      this._configLoaded = true;
      return response.providers;
    } catch (err) {
      console.error('Failed to load auth provider config', err);
      return [];
    }
  }

  /**
   * Get provider config by name.
   */
  getProviderConfig(name: string): AuthProviderConfig | undefined {
    return this._providerConfigs().find(p => p.name.toLowerCase() === name.toLowerCase());
  }

  // ============================================
  // Email/Password Authentication
  // ============================================

  async register(email: string, password: string, name?: string): Promise<AuthResponse> {
    const response = await firstValueFrom(
      this.apiService.post<AuthResponse>('/auth/register', { email, password, name })
    );
    this.setAuthState(response);
    return response;
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const response = await firstValueFrom(
      this.apiService.post<AuthResponse>('/auth/login', { email, password })
    );
    this.setAuthState(response);
    return response;
  }

  // ============================================
  // Generic BackendOAuth (e.g. GitHub)
  // ============================================

  /**
   * Get the authorization URL for a BackendOAuth provider and redirect.
   */
  async loginWithProvider(provider: string): Promise<void> {
    const response = await firstValueFrom(
      this.apiService.get<{ authorizationUrl: string }>(`/auth/${provider}/authorize`)
    );
    if (response?.authorizationUrl) {
      window.location.href = response.authorizationUrl;
    }
  }

  /**
   * Handle a BackendOAuth callback (exchange code for JWT).
   */
  handleProviderCallback(provider: string, code: string, redirectUri?: string): Observable<AuthResponse> {
    return this.apiService.post<AuthResponse>(`/auth/${provider}/callback`, {
      code,
      redirectUri
    }).pipe(
      tap(response => this.setAuthState(response))
    );
  }

  /**
   * Handle a FrontendOidc login by posting the ID token (for authentication)
   * and access token (for profile retrieval) to the backend.
   */
  handleOidcTokenLogin(provider: string, idToken: string, accessToken?: string): Observable<AuthResponse> {
    return this.apiService.post<AuthResponse>(`/auth/${provider}/token`, {
      idToken,
      accessToken
    }).pipe(
      tap(response => this.setAuthState(response))
    );
  }

  // ============================================
  // Linked Providers Management
  // ============================================

  getLinkedProviders(): Observable<LinkedProvider[]> {
    return this.apiService.get<LinkedProvider[]>('/auth/providers');
  }

  /**
   * Link a provider using a backend code exchange (BackendOAuth).
   */
  linkProviderWithCode(provider: string, code: string, redirectUri?: string): Observable<{ message: string; username: string }> {
    return this.apiService.post<{ message: string; username: string }>(`/auth/link/${provider}/callback`, {
      code,
      redirectUri
    });
  }

  /**
   * Link a provider using frontend-obtained tokens (FrontendOidc).
   * Sends ID token for auth validation and access token for profile retrieval.
   */
  linkProviderWithToken(provider: string, idToken: string, accessToken?: string): Observable<{ message: string; username: string }> {
    return this.apiService.post<{ message: string; username: string }>(`/auth/link/${provider}/token`, {
      idToken,
      accessToken
    });
  }

  /**
   * Get authorization URL for linking a BackendOAuth provider (when already logged in).
   */
  getLinkAuthorizationUrl(provider: string): Observable<{ authorizationUrl: string }> {
    return this.apiService.get<{ authorizationUrl: string }>(`/auth/link/${provider}/authorize`);
  }

  unlinkProvider(provider: string): Observable<{ message: string }> {
    return this.apiService.delete<{ message: string }>(`/auth/unlink/${provider}`);
  }

  // ============================================
  // Core Auth Methods
  // ============================================

  getToken(): string | null {
    return this.tokenSignal();
  }

  getCurrentUser(): User | null {
    return this.userSignal();
  }

  isLoggedIn(): boolean {
    return this.isAuthenticated() && this.tokenSignal() !== null;
  }

  logout(): void {
    this.tokenSignal.set(null);
    this.userSignal.set(null);
    this.isAuthenticated.set(false);
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
  }

  private setAuthState(response: AuthResponse): void {
    this.tokenSignal.set(response.token);
    this.userSignal.set(response.user);
    this.isAuthenticated.set(true);
    this.isAdminSignal.set(this.decodeIsAdmin(response.token));
    localStorage.setItem('auth_token', response.token);
    localStorage.setItem('auth_user', JSON.stringify(response.user));
  }

  // ============================================
  // Provider Settings (PAT Management)
  // ============================================

  getProviderSettings(): Observable<ProviderSettings> {
    return this.apiService.get<ProviderSettings>('/auth/settings/providers');
  }

  saveAzureDevOpsSettings(organization?: string, pat?: string): Observable<{ message: string }> {
    return this.apiService.post<{ message: string }>('/auth/settings/azure-devops', {
      organization,
      personalAccessToken: pat
    });
  }

  saveGitHubSettings(pat?: string): Observable<{ message: string }> {
    return this.apiService.post<{ message: string }>('/auth/settings/github', {
      personalAccessToken: pat
    });
  }

  clearAzureDevOpsSettings(): Observable<{ message: string }> {
    return this.apiService.delete<{ message: string }>('/auth/settings/azure-devops');
  }

  clearGitHubSettings(): Observable<{ message: string }> {
    return this.apiService.delete<{ message: string }>('/auth/settings/github');
  }

  // ============================================
  // AI Configuration
  // ============================================

  getAiSettings(): Observable<AiSettings> {
    return this.apiService.get<AiSettings>('/auth/settings/ai');
  }

  getFullAiSettings(repositoryId?: string): Observable<AiSettingsFull> {
    const q = repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : '';
    return this.apiService.get<AiSettingsFull>(`/auth/settings/ai/full${q}`);
  }

  // ============================================
  // LLM Settings (AI providers – single source of truth)
  // ============================================

  getLlmSettings(): Observable<LlmSettingDto[]> {
    return this.apiService.get<LlmSettingDto[]>('/auth/settings/llm');
  }

  createLlmSetting(body: CreateLlmSettingRequest): Observable<LlmSettingDto> {
    return this.apiService.post<LlmSettingDto>('/auth/settings/llm', body);
  }

  updateLlmSetting(id: string, body: UpdateLlmSettingRequest): Observable<LlmSettingDto> {
    return this.apiService.patch<LlmSettingDto>(`/auth/settings/llm/${id}`, body);
  }

  deleteLlmSetting(id: string): Observable<{ message: string }> {
    return this.apiService.delete<{ message: string }>(`/auth/settings/llm/${id}`);
  }

  setDefaultLlmSetting(id: string): Observable<{ message: string }> {
    return this.apiService.post<{ message: string }>(`/auth/settings/llm/${id}/set-default`, {});
  }

  /** Connectivity check (models / minimal request); same permissions as viewing the setting. */
  testLlmSetting(id: string): Observable<{ ok: boolean }> {
    return this.apiService.post<{ ok: boolean }>(`/auth/settings/llm/${id}/test`, {});
  }

  // ============================================
  // Admin — shared LLM provider management
  // ============================================

  adminGetSharedLlmSettings(): Observable<LlmSettingDto[]> {
    return this.apiService.get<LlmSettingDto[]>('/auth/admin/llm');
  }

  adminCreateSharedLlmSetting(body: CreateLlmSettingRequest): Observable<LlmSettingDto> {
    return this.apiService.post<LlmSettingDto>('/auth/admin/llm', body);
  }

  adminUpdateSharedLlmSetting(id: string, body: UpdateLlmSettingRequest): Observable<LlmSettingDto> {
    return this.apiService.patch<LlmSettingDto>(`/auth/admin/llm/${id}`, body);
  }

  adminDeleteSharedLlmSetting(id: string): Observable<{ message: string }> {
    return this.apiService.delete<{ message: string }>(`/auth/admin/llm/${id}`);
  }

  // ============================================
  // Admin — user roles
  // ============================================

  adminListUsers(): Observable<AdminUserListItem[]> {
    return this.apiService.get<AdminUserListItem[]>('/users/all');
  }

  adminSetUserAdmin(
    id: string,
    isAdmin: boolean
  ): Observable<{ message: string; auth?: AuthResponse }> {
    return this.apiService.patch<{ message: string; auth?: AuthResponse }>(`/users/${id}/admin`, { isAdmin });
  }

  /** Apply a new JWT/user payload (e.g. after updating the signed-in user’s admin flag). */
  applyAuthResponse(response: AuthResponse): void {
    this.setAuthState(response);
  }
}

export interface LlmSettingDto {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl?: string;
  isDefault: boolean;
  hasApiKey: boolean;
  /** True when this is an admin-created shared provider (read-only for regular users). */
  isShared?: boolean;
}

export interface CreateLlmSettingRequest {
  name?: string;
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  isDefault?: boolean;
}

export interface UpdateLlmSettingRequest {
  name?: string;
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  isDefault?: boolean;
}

export interface ProviderSettings {
  azureDevOpsOrganization?: string;
  hasAzureDevOpsPat: boolean;
  hasGitHubPat: boolean;
}

export interface AiSettings {
  provider?: string;
  hasApiKey: boolean;
  model?: string;
  baseUrl?: string;
}

export interface AiSettingsFull {
  provider: string;
  apiKey?: string;
  model: string;
  baseUrl?: string;
}
