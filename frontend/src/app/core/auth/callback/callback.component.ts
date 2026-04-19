import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { AuthService } from '../../services/auth.service';
import { RepositoryService } from '../../services/repository.service';
import { switchMap, catchError, take } from 'rxjs/operators';
import { of, firstValueFrom } from 'rxjs';

/**
 * Generic OAuth2 / OIDC callback component.
 *
 * Route: /auth/callback/:provider
 *
 * Behaviour per provider type:
 *  - FrontendOidc (e.g. AzureAd, Duende): uses OidcSecurityService.checkAuth() to
 *    complete the OIDC redirect, then sends the access token to the backend.
 *  - BackendOAuth (e.g. GitHub): extracts `code` from query params, sends to
 *    backend for code exchange.
 *
 * Supports both "login" and "link" flows based on the `state` query param.
 */
@Component({
  selector: 'app-callback',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="callback-container">
      <div class="callback-card">
        @if (loading()) {
          <div class="spinner"></div>
          <h2>{{ statusMessage() }}</h2>
          <p class="subtitle">Please wait...</p>
        } @else if (error()) {
          <div class="error-icon">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 8V12M12 16H12.01M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <h2>Authentication failed</h2>
          <p class="error-message">{{ error() }}</p>
          <button (click)="goToLogin()" class="back-button">Back to Login</button>
        } @else {
          <div class="success-icon">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 12L11 14L15 10M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <h2>Login successful!</h2>
          <p class="subtitle">Redirecting...</p>
        }
      </div>
    </div>
  `,
  styles: [`
    .callback-container {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--surface-ground);
      padding: 2rem;
    }
    .callback-card {
      background: var(--surface-card);
      border: 1px solid var(--border-default);
      border-radius: 16px;
      padding: 3rem;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    h2 {
      margin: 0 0 0.5rem 0;
      color: var(--text-primary);
      font-size: 1.5rem;
      font-weight: 600;
    }
    .subtitle {
      color: var(--text-secondary);
      margin: 0;
    }
    .spinner {
      width: 48px;
      height: 48px;
      border: 4px solid var(--border-light);
      border-top-color: var(--brand-primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 1.5rem;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .error-icon, .success-icon {
      width: 56px;
      height: 56px;
      margin: 0 auto 1rem;
    }
    .error-icon svg {
      width: 100%;
      height: 100%;
      color: #ef4444;
    }
    .success-icon svg {
      width: 100%;
      height: 100%;
      color: #10b981;
    }
    .error-message {
      color: #ef4444;
      margin: 1rem 0;
      font-size: 0.875rem;
    }
    .back-button {
      margin-top: 1.5rem;
      padding: 0.75rem 1.5rem;
      background: linear-gradient(135deg, var(--brand-primary) 0%, #4f46e5 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .back-button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
    }
  `]
})
export class CallbackComponent implements OnInit {
  loading = signal<boolean>(true);
  error = signal<string | null>(null);
  statusMessage = signal<string>('Completing login...');

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private oidcSecurityService: OidcSecurityService,
    private authService: AuthService,
    private repositoryService: RepositoryService
  ) {}

  async ngOnInit(): Promise<void> {
    // Make sure provider config is loaded
    await this.authService.loadProviderConfig();

    const provider = this.route.snapshot.paramMap.get('provider') ?? '';
    const config = this.authService.getProviderConfig(provider);

    if (!config) {
      this.error.set(`Unknown provider: ${provider}`);
      this.loading.set(false);
      return;
    }

    // take(1) so we only process the callback once — OAuth codes are single-use;
    // a second request would get "bad_verification_code" from GitHub.
    this.route.queryParams.pipe(take(1)).subscribe(params => {
      const errorParam = params['error'];
      if (errorParam) {
        this.error.set(`${provider} authorization failed: ${errorParam}`);
        this.loading.set(false);
        return;
      }

      const state = params['state'];
      const isLinking = state === 'link';

      if (config.type === 'FrontendOidc') {
        this.handleOidcCallback(provider, isLinking);
      } else       if (config.type === 'BackendOAuth') {
        const code = params['code'];
        if (!code) {
          this.error.set('Authorization code not found');
          this.loading.set(false);
          return;
        }
        // Remove code from URL immediately so refresh/double-nav cannot resend it (GitHub codes are single-use).
        if (typeof window !== 'undefined' && window.history?.replaceState) {
          const cleanUrl = `${window.location.origin}${window.location.pathname}`;
          window.history.replaceState({}, '', cleanUrl);
        }
        if (isLinking) {
          this.handleBackendOAuthLink(provider, code);
        } else {
          this.handleBackendOAuthLogin(provider, code);
        }
      } else {
        this.error.set(`Provider '${provider}' does not support callbacks`);
        this.loading.set(false);
      }
    });
  }

  /**
   * FrontendOidc callback: use angular-auth-oidc-client to process the redirect,
   * then send the access token to the backend.
   */
  private handleOidcCallback(provider: string, isLinking: boolean): void {
    this.statusMessage.set(`Completing ${provider} sign-in...`);
    const url = typeof window !== 'undefined' ? window.location.href : this.router.url;

    // Log callback context for debugging (avoid logging full URL with code in production)
    const hasCode = typeof window !== 'undefined' && window.location.search.includes('code=');
    const hasState = typeof window !== 'undefined' && window.location.search.includes('state=');
    console.debug('[Auth callback]', {
      provider,
      configId: provider,
      pathname: typeof window !== 'undefined' ? window.location.pathname : '',
      hasCode,
      hasState,
      hashLength: typeof window !== 'undefined' ? (window.location.hash?.length ?? 0) : 0,
    });

    this.oidcSecurityService.checkAuth(url, provider).subscribe({
      next: (loginResponse) => {
        if (!loginResponse.isAuthenticated || !loginResponse.accessToken) {
          console.warn('[Auth callback] OIDC checkAuth returned unsuccessful:', {
            isAuthenticated: loginResponse.isAuthenticated,
            hasAccessToken: !!loginResponse.accessToken,
            hasIdToken: !!loginResponse.idToken,
            errorMessage: loginResponse.errorMessage ?? null,
            configId: loginResponse.configId ?? null,
          });
          this.error.set(loginResponse.errorMessage || `${provider} sign-in did not return a token`);
          this.loading.set(false);
          return;
        }

        if (isLinking || this.authService.isLoggedIn()) {
          // Link the provider to the current account
          this.authService.linkProviderWithToken(provider, loginResponse.idToken, loginResponse.accessToken).subscribe({
            next: () => {
              this.router.navigate(['/repositories'], { queryParams: { linked: provider } });
            },
            error: (err) => {
              this.error.set(err.error?.message || err.message || `Failed to link ${provider} account`);
              this.loading.set(false);
            }
          });
        } else {
          // Login with the OIDC tokens (ID token for auth, access token for profile)
          this.authService.handleOidcTokenLogin(provider, loginResponse.idToken, loginResponse.accessToken).subscribe({
            next: () => {
              this.router.navigate(['/repositories']);
            },
            error: (err) => {
              this.error.set(err.error?.message || err.message || `Failed to complete ${provider} login`);
              this.loading.set(false);
            }
          });
        }
      },
      error: (err) => {
        console.error('[Auth callback] OIDC checkAuth failed:', err?.message ?? err);
        console.error('[Auth callback] Full error object:', err);
        if (err?.stack) {
          console.debug('[Auth callback] Stack:', err.stack);
        }
        console.warn(
          '[Auth callback] The angular-auth-oidc-client library logs the exact validation failure above (e.g. "authCallback incorrect state", "authCallback incorrect aud", "authCallback incorrect nonce", "Signature validation failed id_token", "authCallback incorrect iss"). Check the console for those messages.'
        );
        this.error.set(err?.message || `Failed to complete ${provider} sign-in`);
        this.loading.set(false);
      }
    });
  }

  /**
   * BackendOAuth login: send code to backend for exchange, then navigate.
   */
  private handleBackendOAuthLogin(provider: string, code: string, redirectUri?: string): void {
    this.statusMessage.set(`Completing ${provider} login...`);

    this.authService.handleProviderCallback(provider, code, redirectUri).pipe(
      switchMap(() => {
        // Auto-sync repos for GitHub
        if (provider.toLowerCase() === 'github') {
          this.statusMessage.set('Syncing your repositories...');
          return this.repositoryService.syncFromGitHub().pipe(
            catchError(err => {
              console.warn('Auto-sync failed, but login succeeded:', err);
              return of([]);
            })
          );
        }
        return of(null);
      })
    ).subscribe({
      next: () => {
        this.router.navigate(['/repositories']);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || `Failed to complete ${provider} authentication`);
        this.loading.set(false);
      }
    });
  }

  /**
   * BackendOAuth link: send code to backend for linking.
   */
  private handleBackendOAuthLink(provider: string, code: string, redirectUri?: string): void {
    this.statusMessage.set(`Linking ${provider} account...`);

    this.authService.linkProviderWithCode(provider, code, redirectUri).subscribe({
      next: () => {
        this.router.navigate(['/repositories'], { queryParams: { linked: provider.toLowerCase() } });
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || `Failed to link ${provider} account`);
        this.loading.set(false);
      }
    });
  }

  goToLogin(): void {
    this.router.navigate(['/login']);
  }
}
