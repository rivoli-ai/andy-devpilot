import { Component, OnInit, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { AuthService } from '../../services/auth.service';
import { AuthProviderConfig } from '../../auth/oidc-config.loader';
import { CardComponent } from '../../../shared/components';

/**
 * Login component supporting multiple authentication methods.
 * Providers are discovered dynamically from the backend config.
 */
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, CardComponent],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css'
})
export class LoginComponent implements OnInit {
  private oidcSecurityService = inject(OidcSecurityService);

  // UI State
  loading = signal<boolean>(false);
  error = signal<string | null>(null);
  isRegisterMode = signal<boolean>(false);
  configLoaded = signal<boolean>(false);

  // Form fields
  email = '';
  password = '';
  name = '';
  confirmPassword = '';

  // Provider config from AuthService
  readonly isLocalEnabled = computed(() => this.authService.isLocalEnabled());
  readonly backendOAuthProviders = computed(() => this.authService.backendOAuthProviders());
  readonly frontendOidcProviders = computed(() => this.authService.frontendOidcProviders());
  readonly hasExternalProviders = computed(() =>
    this.backendOAuthProviders().length > 0 || this.frontendOidcProviders().length > 0
  );

  constructor(
    private authService: AuthService,
    private router: Router
  ) {}

  async ngOnInit(): Promise<void> {
    // If already authenticated, redirect to repositories
    if (this.authService.isLoggedIn()) {
      this.router.navigate(['/repositories']);
      return;
    }

    // Load provider config from backend
    await this.authService.loadProviderConfig();
    this.configLoaded.set(true);
  }

  toggleMode(): void {
    this.isRegisterMode.update(value => !value);
    this.error.set(null);
    this.password = '';
    this.confirmPassword = '';
  }

  async submitForm(): Promise<void> {
    if (!this.email || !this.password) {
      this.error.set('Email and password are required');
      return;
    }

    if (this.isRegisterMode()) {
      if (this.password !== this.confirmPassword) {
        this.error.set('Passwords do not match');
        return;
      }
      if (this.password.length < 8) {
        this.error.set('Password must be at least 8 characters');
        return;
      }
    }

    this.loading.set(true);
    this.error.set(null);

    try {
      if (this.isRegisterMode()) {
        await this.authService.register(this.email, this.password, this.name || undefined);
      } else {
        await this.authService.login(this.email, this.password);
      }
      this.router.navigate(['/repositories']);
    } catch (err: any) {
      this.error.set(err.error?.message || err.message || 'Authentication failed');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Login with a BackendOAuth provider (e.g. GitHub).
   * The backend provides the authorization URL, and we redirect.
   */
  loginWithBackendOAuth(provider: AuthProviderConfig): void {
    this.loading.set(true);
    this.error.set(null);

    this.authService.loginWithProvider(provider.name).catch(err => {
      this.error.set(err.message || `Failed to initiate ${provider.name} login`);
      this.loading.set(false);
    });
  }

  /**
   * Login with a FrontendOidc provider (e.g. AzureAd, Duende).
   * The angular-auth-oidc-client library handles the redirect.
   */
  loginWithOidc(provider: AuthProviderConfig): void {
    this.loading.set(true);
    this.error.set(null);

    try {
      this.oidcSecurityService.authorize(provider.name);
    } catch (err: any) {
      this.error.set(err.message || `Failed to initiate ${provider.name} login`);
      this.loading.set(false);
    }
  }

  /**
   * Get a display-friendly name for a provider.
   */
  getProviderDisplayName(provider: AuthProviderConfig): string {
    const nameMap: Record<string, string> = {
      'github': 'GitHub',
      'azuread': 'Microsoft',
      'duende': 'Duende',
    };
    return nameMap[provider.name.toLowerCase()] ?? provider.name;
  }
}
