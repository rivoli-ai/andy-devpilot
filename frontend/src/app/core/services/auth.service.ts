import { Injectable, signal } from '@angular/core';
import { Observable, tap, firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';

export interface User {
  id: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
  githubUsername?: string;
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
 * Service for authentication supporting multiple methods:
 * - Email/Password (login and register)
 * - GitHub OAuth
 * - Microsoft OAuth
 * 
 * Manages JWT tokens and user state
 */
@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly tokenSignal = signal<string | null>(null);
  private readonly userSignal = signal<User | null>(null);

  // Expose readonly signals
  readonly token = this.tokenSignal.asReadonly();
  readonly user = this.userSignal.asReadonly();
  readonly isAuthenticated = signal<boolean>(false);

  constructor(private apiService: ApiService) {
    // Load token from localStorage on init
    const savedToken = localStorage.getItem('auth_token');
    const savedUser = localStorage.getItem('auth_user');
    if (savedToken) {
      this.tokenSignal.set(savedToken);
      this.isAuthenticated.set(true);
    }
    if (savedUser) {
      try {
        this.userSignal.set(JSON.parse(savedUser));
      } catch (e) {
        console.error('Failed to parse saved user', e);
      }
    }
  }

  // ============================================
  // Email/Password Authentication
  // ============================================

  /**
   * Register a new user with email and password
   */
  async register(email: string, password: string, name?: string): Promise<AuthResponse> {
    const response = await firstValueFrom(
      this.apiService.post<AuthResponse>('/auth/register', { email, password, name })
    );
    this.setAuthState(response);
    return response;
  }

  /**
   * Login with email and password
   */
  async login(email: string, password: string): Promise<AuthResponse> {
    const response = await firstValueFrom(
      this.apiService.post<AuthResponse>('/auth/login', { email, password })
    );
    this.setAuthState(response);
    return response;
  }

  // ============================================
  // GitHub OAuth
  // ============================================

  /**
   * Get GitHub OAuth2 authorization URL
   */
  getGitHubAuthorizationUrl(): Observable<{ authorizationUrl: string }> {
    return this.apiService.get<{ authorizationUrl: string }>('/auth/github/authorize');
  }

  /**
   * Handle GitHub OAuth2 callback
   * Exchanges authorization code for JWT token
   */
  handleGitHubCallback(code: string): Observable<AuthResponse> {
    return this.apiService.post<AuthResponse>('/auth/github/callback', { code }).pipe(
      tap(response => this.setAuthState(response))
    );
  }

  /**
   * Initialize GitHub OAuth flow
   * Redirects user to GitHub authorization page
   */
  async loginWithGitHub(): Promise<void> {
    const response = await firstValueFrom(this.getGitHubAuthorizationUrl());
    if (response?.authorizationUrl) {
      window.location.href = response.authorizationUrl;
    }
  }

  // ============================================
  // Microsoft OAuth
  // ============================================

  /**
   * Get Microsoft OAuth2 authorization URL
   */
  getMicrosoftAuthorizationUrl(): Observable<{ authorizationUrl: string }> {
    return this.apiService.get<{ authorizationUrl: string }>('/auth/microsoft/authorize');
  }

  /**
   * Handle Microsoft OAuth2 callback
   * Exchanges authorization code for JWT token
   */
  handleMicrosoftCallback(code: string): Observable<AuthResponse> {
    return this.apiService.post<AuthResponse>('/auth/microsoft/callback', { code }).pipe(
      tap(response => this.setAuthState(response))
    );
  }

  /**
   * Initialize Microsoft OAuth flow
   * Redirects user to Microsoft authorization page
   */
  async loginWithMicrosoft(): Promise<void> {
    const response = await firstValueFrom(this.getMicrosoftAuthorizationUrl());
    if (response?.authorizationUrl) {
      window.location.href = response.authorizationUrl;
    }
  }

  // ============================================
  // Linked Providers Management
  // ============================================

  /**
   * Get all linked providers for the current user
   */
  getLinkedProviders(): Observable<LinkedProvider[]> {
    return this.apiService.get<LinkedProvider[]>('/auth/providers');
  }

  /**
   * Link GitHub to current account
   */
  linkGitHub(code: string, redirectUri?: string): Observable<{ message: string; username: string }> {
    return this.apiService.post<{ message: string; username: string }>('/auth/link/github', { 
      code, 
      redirectUri 
    });
  }

  /**
   * Link Azure DevOps to current account
   */
  linkAzureDevOps(code: string, redirectUri?: string): Observable<{ message: string; username: string }> {
    return this.apiService.post<{ message: string; username: string }>('/auth/link/azure-devops', { 
      code, 
      redirectUri 
    });
  }

  /**
   * Unlink a provider from current account
   */
  unlinkProvider(provider: string): Observable<{ message: string }> {
    return this.apiService.delete<{ message: string }>(`/auth/unlink/${provider}`);
  }

  /**
   * Get authorization URL for linking GitHub (when already logged in)
   */
  getGitHubLinkAuthorizationUrl(): Observable<{ authorizationUrl: string }> {
    return this.apiService.get<{ authorizationUrl: string }>('/auth/link/github/authorize');
  }

  /**
   * Get authorization URL for linking Azure DevOps
   */
  getAzureDevOpsLinkAuthorizationUrl(): Observable<{ authorizationUrl: string }> {
    return this.apiService.get<{ authorizationUrl: string }>('/auth/link/azure-devops/authorize');
  }

  // ============================================
  // Core Auth Methods
  // ============================================

  /**
   * Get current JWT token
   */
  getToken(): string | null {
    return this.tokenSignal();
  }

  /**
   * Get current user
   */
  getCurrentUser(): User | null {
    return this.userSignal();
  }

  /**
   * Check if user is authenticated
   */
  isLoggedIn(): boolean {
    return this.isAuthenticated() && this.tokenSignal() !== null;
  }

  /**
   * Logout - clear token and user
   */
  logout(): void {
    this.tokenSignal.set(null);
    this.userSignal.set(null);
    this.isAuthenticated.set(false);
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
  }

  /**
   * Private helper to set auth state
   */
  private setAuthState(response: AuthResponse): void {
    this.tokenSignal.set(response.token);
    this.userSignal.set(response.user);
    this.isAuthenticated.set(true);
    // Store in localStorage
    localStorage.setItem('auth_token', response.token);
    localStorage.setItem('auth_user', JSON.stringify(response.user));
  }

  // ============================================
  // Provider Settings (PAT Management)
  // ============================================

  /**
   * Get provider settings
   */
  getProviderSettings(): Observable<ProviderSettings> {
    return this.apiService.get<ProviderSettings>('/auth/settings/providers');
  }

  /**
   * Save Azure DevOps settings
   */
  saveAzureDevOpsSettings(organization?: string, pat?: string): Observable<{ message: string }> {
    return this.apiService.post<{ message: string }>('/auth/settings/azure-devops', {
      organization,
      personalAccessToken: pat
    });
  }

  /**
   * Save GitHub PAT settings
   */
  saveGitHubSettings(pat?: string): Observable<{ message: string }> {
    return this.apiService.post<{ message: string }>('/auth/settings/github', {
      personalAccessToken: pat
    });
  }

  /**
   * Clear Azure DevOps settings
   */
  clearAzureDevOpsSettings(): Observable<{ message: string }> {
    return this.apiService.delete<{ message: string }>('/auth/settings/azure-devops');
  }

  /**
   * Clear GitHub settings
   */
  clearGitHubSettings(): Observable<{ message: string }> {
    return this.apiService.delete<{ message: string }>('/auth/settings/github');
  }

  // ============================================
  // AI Configuration
  // ============================================

  /**
   * Get AI settings
   */
  getAiSettings(): Observable<AiSettings> {
    return this.apiService.get<AiSettings>('/auth/settings/ai');
  }

  /**
   * Get full AI settings with API key (for sandbox creation)
   */
  getFullAiSettings(): Observable<AiSettingsFull> {
    return this.apiService.get<AiSettingsFull>('/auth/settings/ai/full');
  }

  /**
   * Save AI settings
   */
  saveAiSettings(provider?: string, apiKey?: string, model?: string, baseUrl?: string): Observable<{ message: string }> {
    return this.apiService.post<{ message: string }>('/auth/settings/ai', {
      provider,
      apiKey,
      model,
      baseUrl
    });
  }

  /**
   * Clear AI settings
   */
  clearAiSettings(): Observable<{ message: string }> {
    return this.apiService.delete<{ message: string }>('/auth/settings/ai');
  }
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
