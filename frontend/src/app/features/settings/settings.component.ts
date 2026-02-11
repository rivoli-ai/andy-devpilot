import { Component, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { AuthService, LinkedProvider, User, ProviderSettings } from '../../core/services/auth.service';
import { AuthProviderConfig } from '../../core/auth/oidc-config.loader';
import { firstValueFrom } from 'rxjs';

/**
 * Settings page for managing linked providers and account settings.
 * Provider list is driven by the backend config (enabled providers).
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.css'
})
export class SettingsComponent implements OnInit {
  user = signal<User | null>(null);
  linkedProviders = signal<LinkedProvider[]>([]);
  loading = signal<boolean>(true);
  actionLoading = signal<string | null>(null);
  error = signal<string | null>(null);
  successMessage = signal<string | null>(null);

  // Azure DevOps PAT configuration
  azureDevOpsOrg = signal<string>('');
  azureDevOpsPat = signal<string>('');
  showAzurePat = signal<boolean>(false);
  hasAzureDevOpsPat = signal<boolean>(false);

  // GitHub: OAuth or PAT (same section, user selects)
  githubConnectionMode = signal<'oauth' | 'pat'>('oauth');
  githubPat = signal<string>('');
  showGitHubPat = signal<boolean>(false);
  hasGitHubPat = signal<boolean>(false);

  // AI Configuration
  aiProvider = signal<'openai' | 'anthropic' | 'ollama' | 'custom'>('openai');
  aiApiKey = signal<string>('');
  aiModel = signal<string>('gpt-4o');
  aiBaseUrl = signal<string>('');
  showAiApiKey = signal<boolean>(false);
  hasAiApiKey = signal<boolean>(false);

  /** Providers that can be linked in Connected Providers. Excludes Duende, Azure AD, and GitHub (GitHub has its own row with OAuth/PAT choice). */
  readonly linkableProviders = computed(() => {
    return this.authService.providerConfigs().filter(p => {
      if (p.type === 'Local') return false;
      if (p.name.toLowerCase() === 'duende') return false;
      if (p.name.toLowerCase() === 'azuread') return false;
      if (p.name.toLowerCase() === 'github') return false;
      return true;
    });
  });

  /** GitHub provider config for OAuth connect (used in the combined GitHub row). */
  readonly githubProviderConfig = computed(() =>
    this.authService.providerConfigs().find(p => p.name.toLowerCase() === 'github') ?? null
  );

  constructor(
    private authService: AuthService,
    private oidcSecurityService: OidcSecurityService,
    private router: Router,
    private route: ActivatedRoute
  ) {}

  async ngOnInit(): Promise<void> {
    if (!this.authService.isLoggedIn()) {
      this.router.navigate(['/login']);
      return;
    }

    this.user.set(this.authService.getCurrentUser());

    // Load provider config from backend
    await this.authService.loadProviderConfig();

    this.loadLinkedProviders();
    this.loadProviderSettings();

    // Check for success message from OAuth callback
    this.route.queryParams.subscribe(params => {
      if (params['linked']) {
        const provider = params['linked'];
        const displayName = this.getProviderDisplayName(provider);
        this.successMessage.set(`${displayName} account linked successfully!`);
        this.actionLoading.set(null);
        this.loadLinkedProviders();
        this.router.navigate([], { queryParams: {} });
        setTimeout(() => this.successMessage.set(null), 5000);
      }
    });
  }

  // ---- Provider settings ----

  async loadProviderSettings(): Promise<void> {
    try {
      const settings = await firstValueFrom(this.authService.getProviderSettings());
      if (settings.azureDevOpsOrganization) {
        this.azureDevOpsOrg.set(settings.azureDevOpsOrganization);
      }
      this.hasAzureDevOpsPat.set(settings.hasAzureDevOpsPat);
      this.hasGitHubPat.set(settings.hasGitHubPat);
    } catch (err) {
      console.error('Failed to load provider settings:', err);
    }

    try {
      const aiSettings = await firstValueFrom(this.authService.getAiSettings());
      if (aiSettings.provider) {
        this.aiProvider.set(aiSettings.provider as any);
      }
      if (aiSettings.model) {
        this.aiModel.set(aiSettings.model);
      }
      if (aiSettings.baseUrl) {
        this.aiBaseUrl.set(aiSettings.baseUrl);
      }
      this.hasAiApiKey.set(aiSettings.hasApiKey);
    } catch (err) {
      console.error('Failed to load AI settings:', err);
    }
  }

  // ---- Linked providers ----

  async loadLinkedProviders(): Promise<void> {
    this.loading.set(true);
    try {
      const providers = await firstValueFrom(this.authService.getLinkedProviders());
      this.linkedProviders.set(providers);
    } catch (err: any) {
      console.error('Failed to load linked providers:', err);
      this.error.set('Failed to load linked providers');
    } finally {
      this.loading.set(false);
    }
  }

  isProviderLinked(provider: string): boolean {
    // Normalize: check both the config name and the ProviderTypes constant
    const normalizedName = this.normalizeProviderName(provider);
    return this.linkedProviders().some(p =>
      p.provider === provider || p.provider === normalizedName
    );
  }

  getProviderUsername(provider: string): string | null {
    const normalizedName = this.normalizeProviderName(provider);
    const linked = this.linkedProviders().find(p =>
      p.provider === provider || p.provider === normalizedName
    );
    return linked?.providerUsername || null;
  }

  getProviderLinkedDate(provider: string): string | null {
    const normalizedName = this.normalizeProviderName(provider);
    const linked = this.linkedProviders().find(p =>
      p.provider === provider || p.provider === normalizedName
    );
    if (linked?.linkedAt) {
      return new Date(linked.linkedAt).toLocaleDateString();
    }
    return null;
  }

  getProviderDisplayName(provider: string): string {
    const nameMap: Record<string, string> = {
      'github': 'GitHub',
      'azuread': 'Azure DevOps',
      'duende': 'Duende',
    };
    return nameMap[provider.toLowerCase()] ?? provider;
  }

  /**
   * Link an external provider. Behaviour depends on the provider type.
   */
  async linkProvider(config: AuthProviderConfig): Promise<void> {
    this.actionLoading.set(config.name.toLowerCase());
    this.error.set(null);

    try {
      if (config.type === 'BackendOAuth') {
        // Redirect to backend-provided authorization URL
        const response = await firstValueFrom(
          this.authService.getLinkAuthorizationUrl(config.name)
        );
        if (response?.authorizationUrl) {
          window.location.href = response.authorizationUrl;
        }
      } else if (config.type === 'FrontendOidc') {
        // Use angular-auth-oidc-client to initiate OIDC flow
        const configs = this.oidcSecurityService.getConfigurations();
        const hasConfig = configs.some((c: { configId?: string }) => c.configId === config.name);
        if (!hasConfig) {
          this.error.set(`${this.getProviderDisplayName(config.name)} sign-in is not configured on the server.`);
          this.actionLoading.set(null);
          return;
        }
        this.oidcSecurityService.authorize(config.name);
        // Redirect happens; loading stays until user returns or cancels
      }
    } catch (err: any) {
      this.error.set(err?.message || err?.error?.message || `Failed to initiate ${config.name} linking`);
      this.actionLoading.set(null);
    }
  }

  async unlinkProvider(provider: string): Promise<void> {
    const displayName = this.getProviderDisplayName(provider);
    if (!confirm(`Are you sure you want to unlink ${displayName}? You will need to reconnect to sync repositories from this provider.`)) {
      return;
    }

    this.actionLoading.set(provider.toLowerCase());
    this.error.set(null);
    try {
      // Use the normalized provider name for the API call
      const normalizedName = this.normalizeProviderName(provider);
      await firstValueFrom(this.authService.unlinkProvider(normalizedName));
      this.successMessage.set(`${displayName} unlinked successfully`);
      await this.loadLinkedProviders();
      setTimeout(() => this.successMessage.set(null), 5000);
    } catch (err: any) {
      this.error.set(err.error?.message || `Failed to unlink ${displayName}`);
    } finally {
      this.actionLoading.set(null);
    }
  }

  // ---- Azure DevOps PAT settings ----

  async saveAzureDevOpsSettings(): Promise<void> {
    this.actionLoading.set('azure-settings');
    this.error.set(null);

    try {
      const org = this.azureDevOpsOrg().trim() || undefined;
      const pat = this.azureDevOpsPat().trim() || undefined;

      await firstValueFrom(this.authService.saveAzureDevOpsSettings(org, pat));

      this.azureDevOpsPat.set('');
      this.hasAzureDevOpsPat.set(!!pat || this.hasAzureDevOpsPat());

      this.successMessage.set('Azure DevOps settings saved successfully!');
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err.error?.message || 'Failed to save Azure DevOps settings');
    } finally {
      this.actionLoading.set(null);
    }
  }

  async clearAzureDevOpsSettings(): Promise<void> {
    if (!confirm('Are you sure you want to clear Azure DevOps settings?')) {
      return;
    }

    this.actionLoading.set('azure-clear');
    try {
      await firstValueFrom(this.authService.clearAzureDevOpsSettings());
      this.azureDevOpsOrg.set('');
      this.azureDevOpsPat.set('');
      this.hasAzureDevOpsPat.set(false);
      this.successMessage.set('Azure DevOps settings cleared');
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err.error?.message || 'Failed to clear settings');
    } finally {
      this.actionLoading.set(null);
    }
  }

  toggleShowAzurePat(): void {
    this.showAzurePat.update(v => !v);
  }

  hasAzureDevOpsConfig(): boolean {
    return !!(this.azureDevOpsOrg() || this.hasAzureDevOpsPat());
  }

  // ---- GitHub PAT settings ----

  async saveGitHubSettings(): Promise<void> {
    this.actionLoading.set('github-settings');
    this.error.set(null);

    try {
      const pat = this.githubPat().trim() || undefined;
      await firstValueFrom(this.authService.saveGitHubSettings(pat));
      this.githubPat.set('');
      this.hasGitHubPat.set(!!pat || this.hasGitHubPat());
      this.successMessage.set('GitHub PAT saved successfully!');
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err.error?.message || 'Failed to save GitHub settings');
    } finally {
      this.actionLoading.set(null);
    }
  }

  async clearGitHubSettings(): Promise<void> {
    if (!confirm('Are you sure you want to clear your GitHub PAT? You can still use GitHub via OAuth if connected.')) {
      return;
    }
    this.actionLoading.set('github-clear');
    try {
      await firstValueFrom(this.authService.clearGitHubSettings());
      this.githubPat.set('');
      this.hasGitHubPat.set(false);
      this.successMessage.set('GitHub PAT cleared');
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err.error?.message || 'Failed to clear GitHub PAT');
    } finally {
      this.actionLoading.set(null);
    }
  }

  toggleShowGitHubPat(): void {
    this.showGitHubPat.update(v => !v);
  }

  // ---- AI Configuration ----

  setAiProvider(provider: 'openai' | 'anthropic' | 'ollama' | 'custom'): void {
    this.aiProvider.set(provider);
    switch (provider) {
      case 'openai':
        this.aiModel.set('gpt-4o');
        break;
      case 'anthropic':
        this.aiModel.set('claude-sonnet-4-20250514');
        break;
      case 'ollama':
        this.aiModel.set('llama3.1');
        break;
      case 'custom':
        this.aiModel.set('');
        break;
    }
  }

  toggleShowAiApiKey(): void {
    this.showAiApiKey.update(v => !v);
  }

  async saveAiSettings(): Promise<void> {
    this.actionLoading.set('ai-settings');
    this.error.set(null);

    try {
      const provider = this.aiProvider();
      const apiKey = this.aiApiKey().trim() || undefined;
      const model = this.aiModel().trim() || undefined;
      const baseUrl = this.aiBaseUrl().trim() || undefined;

      await firstValueFrom(this.authService.saveAiSettings(provider, apiKey, model, baseUrl));

      this.aiApiKey.set('');
      this.hasAiApiKey.set(!!apiKey || this.hasAiApiKey());

      this.successMessage.set('AI settings saved successfully!');
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err.error?.message || 'Failed to save AI settings');
    } finally {
      this.actionLoading.set(null);
    }
  }

  async clearAiSettings(): Promise<void> {
    if (!confirm('Are you sure you want to clear AI settings?')) {
      return;
    }

    this.actionLoading.set('ai-clear');
    try {
      await firstValueFrom(this.authService.clearAiSettings());
      this.aiProvider.set('openai');
      this.aiApiKey.set('');
      this.aiModel.set('gpt-4o');
      this.aiBaseUrl.set('');
      this.hasAiApiKey.set(false);
      this.successMessage.set('AI settings cleared');
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err.error?.message || 'Failed to clear settings');
    } finally {
      this.actionLoading.set(null);
    }
  }

  isAiConfigured(): boolean {
    return this.hasAiApiKey();
  }

  // ---- Misc ----

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  /**
   * Map config provider names to the ProviderTypes constants used in the DB.
   */
  private normalizeProviderName(name: string): string {
    const map: Record<string, string> = {
      'github': 'GitHub',
      'azuread': 'AzureDevOps',
      'duende': 'Duende',
    };
    return map[name.toLowerCase()] ?? name;
  }
}
