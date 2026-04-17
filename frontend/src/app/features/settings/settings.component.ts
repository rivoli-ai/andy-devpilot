import { Component, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { AuthService, AdminUserListItem, LinkedProvider, ProviderSettings, LlmSettingDto } from '../../core/services/auth.service';
import { AuthProviderConfig } from '../../core/auth/oidc-config.loader';
import { AIConfigService } from '../../core/services/ai-config.service';
import { McpConfigService, McpServerDto, McpToolInfo } from '../../core/services/mcp-config.service';
import { ArtifactFeedService, ArtifactFeedDto, AzureDevOpsFeedDto } from '../../core/services/artifact-feed.service';
import { firstValueFrom } from 'rxjs';
import {
  siAnthropic,
  siGithub,
  siModelcontextprotocol,
  siNuget,
  siNpm,
  siPypi
} from 'simple-icons';

export type SettingsSectionTab = 'sourceControl' | 'ai' | 'mcp' | 'artifacts' | 'users';

/**
 * Settings page for managing source-control links, AI, MCP, and artifact feeds.
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.css'
})
export class SettingsComponent implements OnInit {
  /** Active section in the tabbed settings layout (Google-style). */
  settingsTab = signal<SettingsSectionTab>('sourceControl');

  /** Simple Icons paths for tab labels (filled with currentColor in the template). */
  readonly settingsTabIconSourceControl = siGithub;
  readonly settingsTabIconAi = siAnthropic;
  readonly settingsTabIconMcp = siModelcontextprotocol;
  readonly settingsTabIconArtifacts = siNuget;
  /** Tab icon path (Material-style “people”, 24×24). */
  readonly settingsTabIconUsersPath =
    'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z';

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

  // AI providers (multiple configs + default)
  llmFormOpen = signal<boolean>(false);
  llmFormId = signal<string | null>(null);
  llmFormName = signal<string>('');
  llmFormProvider = signal<'openai' | 'anthropic' | 'ollama' | 'custom'>('openai');
  llmFormModel = signal<string>('gpt-4o');
  llmFormBaseUrl = signal<string>('');
  llmFormApiKey = signal<string>('');
  llmFormShowApiKey = signal<boolean>(false);

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

  // MCP servers
  mcpFormOpen = signal<boolean>(false);
  mcpFormId = signal<string | null>(null);
  mcpFormIsAdmin = signal<boolean>(false);
  mcpFormName = signal<string>('');
  mcpFormServerType = signal<'stdio' | 'remote'>('stdio');
  mcpFormCommand = signal<string>('');
  mcpFormArgsStr = signal<string>('');
  mcpFormEnvStr = signal<string>('');
  mcpFormUrl = signal<string>('');
  mcpFormHeadersStr = signal<string>('');

  // Artifact feeds
  artifactFormOpen = signal(false);
  artifactFormId = signal<string | null>(null);
  artifactFormName = signal('');
  artifactFormOrg = signal('');
  artifactFormFeedName = signal('');
  artifactFormProjectName = signal('');
  artifactFormFeedType = signal<'nuget' | 'npm' | 'pip'>('nuget');
  artifactBrowseLoading = signal(false);
  artifactBrowseFeeds = signal<AzureDevOpsFeedDto[]>([]);
  artifactBrowseError = signal<string | null>(null);
  /** Filter list after “Browse Feeds” loads Azure DevOps feeds */
  artifactBrowseSearchQuery = signal('');

  adminUsers = signal<AdminUserListItem[]>([]);
  adminUsersLoading = signal(false);
  /** Filter users list (email and name). */
  adminUserSearchQuery = signal('');

  filteredAdminUsers = computed(() => {
    const q = this.adminUserSearchQuery().trim().toLowerCase();
    const list = this.adminUsers();
    if (!q) return list;
    return list.filter(u => {
      const email = (u.email ?? '').toLowerCase();
      const name = (u.name ?? '').toLowerCase();
      return email.includes(q) || name.includes(q);
    });
  });

  filteredArtifactBrowseFeeds = computed(() => {
    const q = this.artifactBrowseSearchQuery().trim().toLowerCase();
    const list = this.artifactBrowseFeeds();
    if (!q) return list;
    return list.filter((bf) => {
      const hay = [bf.name, bf.project ?? '', bf.fullyQualifiedName ?? '', bf.id]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  });

  setSettingsTab(tab: SettingsSectionTab): void {
    this.settingsTab.set(tab);
    if (tab === 'users' && this.authService.isAdmin()) {
      void this.loadAdminUsers();
    }
  }

  constructor(
    private authService: AuthService,
    public aiConfigService: AIConfigService,
    private mcpConfigService: McpConfigService,
    public artifactFeedService: ArtifactFeedService,
    private oidcSecurityService: OidcSecurityService,
    private router: Router,
    private route: ActivatedRoute
  ) {}

  async ngOnInit(): Promise<void> {
    if (!this.authService.isLoggedIn()) {
      this.router.navigate(['/login']);
      return;
    }

    // Load provider config from backend
    await this.authService.loadProviderConfig();

    this.loadLinkedProviders();
    this.loadProviderSettings();
    await this.aiConfigService.loadLlmSettings({ testConnectivity: true });
    await this.mcpConfigService.loadServers();
    await this.artifactFeedService.loadFeeds();
    this.discoverAllRemoteTools();

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

  // ---- AI providers ----

  /** Whether the current user is a super-admin. */
  isAdmin = this.authService.isAdmin;

  async loadAdminUsers(): Promise<void> {
    this.adminUsersLoading.set(true);
    this.error.set(null);
    try {
      const rows = await firstValueFrom(this.authService.adminListUsers());
      this.adminUsers.set(rows);
    } catch (err: any) {
      console.error(err);
      this.error.set(err.error?.message || 'Failed to load users');
      this.adminUsers.set([]);
    } finally {
      this.adminUsersLoading.set(false);
    }
  }

  async updateUserAppAdmin(row: AdminUserListItem, event: Event): Promise<void> {
    if (row.isBootstrapAdmin) return;
    const el = event.target as HTMLInputElement;
    const next = el.checked;
    if (next === row.isAppAdmin) return;
    this.actionLoading.set('admin-user-' + row.id);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.authService.adminSetUserAdmin(row.id, next));
      if (res.auth) {
        this.authService.applyAuthResponse(res.auth);
      }
      await this.loadAdminUsers();
      this.successMessage.set('User roles updated');
      setTimeout(() => this.successMessage.set(null), 4000);
    } catch (err: any) {
      el.checked = row.isAppAdmin;
      this.error.set(err.error?.message || 'Failed to update administrator role');
    } finally {
      this.actionLoading.set(null);
    }
  }

  adminUserActionKey(id: string): string {
    return 'admin-user-' + id;
  }

  llmSettings(): LlmSettingDto[] {
    return this.aiConfigService.llmSettings().filter(s => !s.isShared);
  }

  sharedLlmSettings(): LlmSettingDto[] {
    return this.aiConfigService.llmSettings().filter(s => s.isShared);
  }

  llmConnectivityTitle(item: LlmSettingDto): string {
    if (!this.aiConfigService.isLlmSettingTestable(item)) {
      const p = (item.provider || '').toLowerCase();
      if ((p === 'openai' || p === 'anthropic') && !item.hasApiKey) {
        return 'No API key — connectivity not tested';
      }
      if (p === 'custom' && !item.baseUrl?.trim()) {
        return 'No base URL — connectivity not tested';
      }
      return '';
    }
    const h = this.aiConfigService.getLlmHealthState(item.id);
    if (!h) return '';
    if (h.loading) return 'Testing connection…';
    if (h.error) return h.error;
    if (h.ok) return 'Reachable';
    return '';
  }

  refreshLlmConnectivity(id: string): void {
    void this.aiConfigService.testLlmConnectivity(id);
  }

  llmHealth(item: LlmSettingDto) {
    return this.aiConfigService.getLlmHealthState(item.id);
  }

  // Admin: shared provider form
  readonly adminLlmFormOpen = signal(false);
  readonly adminLlmFormId = signal<string | null>(null);
  readonly adminLlmFormName = signal('');
  readonly adminLlmFormProvider = signal<'openai' | 'anthropic' | 'ollama' | 'custom'>('openai');
  readonly adminLlmFormModel = signal('gpt-4o');
  readonly adminLlmFormBaseUrl = signal('');
  readonly adminLlmFormApiKey = signal('');
  readonly adminLlmFormShowApiKey = signal(false);

  openAdminAddLlmForm(): void {
    this.adminLlmFormId.set(null);
    this.adminLlmFormName.set('');
    this.adminLlmFormProvider.set('openai');
    this.adminLlmFormModel.set('gpt-4o');
    this.adminLlmFormBaseUrl.set('');
    this.adminLlmFormApiKey.set('');
    this.adminLlmFormOpen.set(true);
  }

  openAdminEditLlmForm(item: LlmSettingDto): void {
    this.adminLlmFormId.set(item.id);
    this.adminLlmFormName.set(item.name || '');
    const raw = (item.provider || '').toLowerCase();
    const valid: Array<'openai' | 'anthropic' | 'ollama' | 'custom'> = ['openai', 'anthropic', 'ollama', 'custom'];
    this.adminLlmFormProvider.set(valid.includes(raw as any) ? (raw as any) : 'openai');
    this.adminLlmFormModel.set(item.model || 'gpt-4o');
    this.adminLlmFormBaseUrl.set(item.baseUrl || '');
    this.adminLlmFormApiKey.set('');
    this.adminLlmFormOpen.set(true);
  }

  cancelAdminLlmForm(): void {
    this.adminLlmFormOpen.set(false);
    this.adminLlmFormId.set(null);
  }

  setAdminLlmFormProvider(provider: 'openai' | 'anthropic' | 'ollama' | 'custom'): void {
    this.adminLlmFormProvider.set(provider);
    switch (provider) {
      case 'openai': this.adminLlmFormModel.set('gpt-4o'); break;
      case 'anthropic': this.adminLlmFormModel.set('claude-sonnet-4-20250514'); break;
      case 'ollama': this.adminLlmFormModel.set('llama3.1'); break;
      default: this.adminLlmFormModel.set(''); break;
    }
  }

  async saveAdminLlmSetting(): Promise<void> {
    const id = this.adminLlmFormId();
    const name = this.adminLlmFormName().trim() || undefined;
    const provider = this.adminLlmFormProvider();
    const model = this.adminLlmFormModel().trim() || undefined;
    const baseUrl = this.adminLlmFormBaseUrl().trim() || undefined;
    const apiKey = this.adminLlmFormApiKey().trim() || undefined;

    this.actionLoading.set('admin-llm-save');
    this.error.set(null);
    try {
      if (id) {
        await firstValueFrom(this.authService.adminUpdateSharedLlmSetting(id, { name, provider, apiKey, model, baseUrl }));
        this.successMessage.set('Shared AI provider updated');
      } else {
        await firstValueFrom(this.authService.adminCreateSharedLlmSetting({ name, provider, apiKey, model, baseUrl }));
        this.successMessage.set('Shared AI provider created');
      }
      await this.aiConfigService.loadLlmSettings({ testConnectivity: true });
      this.cancelAdminLlmForm();
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err?.error?.message || err?.message || 'Failed to save');
    } finally {
      this.actionLoading.set(null);
    }
  }

  async deleteAdminLlmSetting(id: string): Promise<void> {
    if (!confirm('Delete this shared AI provider? All users relying on it will lose access.')) return;
    this.actionLoading.set('admin-llm-delete');
    this.error.set(null);
    try {
      await firstValueFrom(this.authService.adminDeleteSharedLlmSetting(id));
      await this.aiConfigService.loadLlmSettings({ testConnectivity: true });
      this.successMessage.set('Shared AI provider deleted');
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err?.error?.message || err?.message || 'Failed to delete');
    } finally {
      this.actionLoading.set(null);
    }
  }

  openAddLlmForm(): void {
    this.llmFormId.set(null);
    this.llmFormName.set('');
    this.llmFormProvider.set('openai');
    this.llmFormModel.set('gpt-4o');
    this.llmFormBaseUrl.set('');
    this.llmFormApiKey.set('');
    this.llmFormOpen.set(true);
  }

  openEditLlmForm(item: LlmSettingDto): void {
    this.llmFormId.set(item.id);
    this.llmFormName.set(item.name || '');
    this.llmFormProvider.set((item.provider as any) || 'openai');
    this.llmFormModel.set(item.model || 'gpt-4o');
    this.llmFormBaseUrl.set(item.baseUrl || '');
    this.llmFormApiKey.set(''); // Never show existing key
    this.llmFormOpen.set(true);
  }

  cancelLlmForm(): void {
    this.llmFormOpen.set(false);
    this.llmFormId.set(null);
  }

  toggleLlmFormShowApiKey(): void {
    this.llmFormShowApiKey.update(v => !v);
  }

  setLlmFormProvider(provider: 'openai' | 'anthropic' | 'ollama' | 'custom'): void {
    this.llmFormProvider.set(provider);
    switch (provider) {
      case 'openai': this.llmFormModel.set('gpt-4o'); break;
      case 'anthropic': this.llmFormModel.set('claude-sonnet-4-20250514'); break;
      case 'ollama': this.llmFormModel.set('llama3.1'); break;
      default: this.llmFormModel.set(''); break;
    }
  }

  async saveLlmSetting(): Promise<void> {
    const id = this.llmFormId();
    const name = this.llmFormName().trim() || undefined;
    const provider = this.llmFormProvider();
    const model = this.llmFormModel().trim() || undefined;
    const baseUrl = this.llmFormBaseUrl().trim() || undefined;
    const apiKey = this.llmFormApiKey().trim() || undefined;

    this.actionLoading.set('llm-save');
    this.error.set(null);
    try {
      if (id) {
        await firstValueFrom(this.authService.updateLlmSetting(id, { name, apiKey, model, baseUrl }));
        this.successMessage.set('LLM configuration updated');
      } else {
        await firstValueFrom(this.authService.createLlmSetting({ name, provider, apiKey, model, baseUrl }));
        this.successMessage.set('LLM configuration added');
      }
      await this.aiConfigService.loadLlmSettings({ testConnectivity: true });
      this.cancelLlmForm();
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err?.error?.message || err?.message || 'Failed to save');
    } finally {
      this.actionLoading.set(null);
    }
  }

  async setDefaultLlm(id: string): Promise<void> {
    this.actionLoading.set('llm-default');
    this.error.set(null);
    try {
      await firstValueFrom(this.authService.setDefaultLlmSetting(id));
      await this.aiConfigService.loadLlmSettings({ testConnectivity: true });
      this.successMessage.set('Default LLM updated');
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err?.error?.message || err?.message || 'Failed to set default');
    } finally {
      this.actionLoading.set(null);
    }
  }

  async deleteLlmSetting(id: string): Promise<void> {
    if (!confirm('Delete this LLM configuration? Repositories using it will fall back to your default.')) return;
    this.actionLoading.set('llm-delete');
    this.error.set(null);
    try {
      await firstValueFrom(this.authService.deleteLlmSetting(id));
      await this.aiConfigService.loadLlmSettings({ testConnectivity: true });
      if (this.llmFormId() === id) this.cancelLlmForm();
      this.successMessage.set('LLM configuration deleted');
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err?.error?.message || err?.message || 'Failed to delete');
    } finally {
      this.actionLoading.set(null);
    }
  }

  // ---- MCP servers ----

  mcpServers(): McpServerDto[] {
    return this.mcpConfigService.servers();
  }

  mcpPersonalServers(): McpServerDto[] {
    return this.mcpConfigService.servers().filter(s => !s.isShared);
  }

  mcpSharedServers(): McpServerDto[] {
    return this.mcpConfigService.servers().filter(s => s.isShared);
  }

  openAddMcpForm(isAdmin: boolean): void {
    this.mcpFormId.set(null);
    this.mcpFormIsAdmin.set(isAdmin);
    this.mcpFormName.set('');
    this.mcpFormServerType.set('stdio');
    this.mcpFormCommand.set('');
    this.mcpFormArgsStr.set('');
    this.mcpFormEnvStr.set('');
    this.mcpFormUrl.set('');
    this.mcpFormHeadersStr.set('');
    this.mcpFormOpen.set(true);
  }

  openEditMcpForm(mcp: McpServerDto): void {
    this.mcpFormId.set(mcp.id);
    this.mcpFormIsAdmin.set(false);
    this.mcpFormName.set(mcp.name);
    this.mcpFormServerType.set(mcp.serverType);
    this.mcpFormCommand.set(mcp.command || '');
    this.mcpFormArgsStr.set(mcp.args?.join(', ') || '');
    this.mcpFormEnvStr.set(this.dictToLines(mcp.env));
    this.mcpFormUrl.set(mcp.url || '');
    this.mcpFormHeadersStr.set(this.dictToLines(mcp.headers));
    this.mcpFormOpen.set(true);
  }

  openEditMcpFormAdmin(mcp: McpServerDto): void {
    this.openEditMcpForm(mcp);
    this.mcpFormIsAdmin.set(true);
  }

  cancelMcpForm(): void {
    this.mcpFormOpen.set(false);
    this.mcpFormId.set(null);
  }

  async saveMcpServer(): Promise<void> {
    const id = this.mcpFormId();
    const payload: any = {
      name: this.mcpFormName().trim() || undefined,
      serverType: this.mcpFormServerType(),
      command: this.mcpFormServerType() === 'stdio' ? (this.mcpFormCommand().trim() || undefined) : undefined,
      args: this.mcpFormServerType() === 'stdio' ? this.parseArgsStr(this.mcpFormArgsStr()) : undefined,
      env: this.mcpFormServerType() === 'stdio' ? this.parseKvLines(this.mcpFormEnvStr()) : undefined,
      url: this.mcpFormServerType() === 'remote' ? (this.mcpFormUrl().trim() || undefined) : undefined,
      headers: this.mcpFormServerType() === 'remote' ? this.parseKvLines(this.mcpFormHeadersStr()) : undefined,
    };

    this.actionLoading.set('mcp-save');
    this.error.set(null);
    try {
      if (id) {
        await this.mcpConfigService.adminUpdate(id, payload);
        this.successMessage.set('MCP server updated');
      } else {
        await this.mcpConfigService.adminCreate(payload);
        this.successMessage.set('MCP server added');
      }
      this.cancelMcpForm();
      this.discoverAllRemoteTools();
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err?.error?.message || err?.message || 'Failed to save MCP server');
    } finally {
      this.actionLoading.set(null);
    }
  }

  async deleteMcpServer(id: string): Promise<void> {
    if (!confirm('Delete this MCP server configuration?')) return;
    this.actionLoading.set('mcp-delete');
    this.error.set(null);
    try {
      await this.mcpConfigService.delete(id);
      this.successMessage.set('MCP server deleted');
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err?.error?.message || err?.message || 'Failed to delete');
    } finally {
      this.actionLoading.set(null);
    }
  }

  async deleteMcpServerAdmin(id: string): Promise<void> {
    if (!confirm('Delete this shared MCP server? All users will lose access.')) return;
    this.actionLoading.set('mcp-admin-delete');
    this.error.set(null);
    try {
      await this.mcpConfigService.adminDelete(id);
      this.successMessage.set('Shared MCP server deleted');
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err?.error?.message || err?.message || 'Failed to delete');
    } finally {
      this.actionLoading.set(null);
    }
  }

  async toggleMcpServer(id: string): Promise<void> {
    try {
      await this.mcpConfigService.toggle(id);
    } catch (err: any) {
      this.error.set(err?.error?.message || 'Failed to toggle MCP server');
    }
  }

  async toggleMcpServerAdmin(mcp: McpServerDto): Promise<void> {
    try {
      await this.mcpConfigService.adminUpdate(mcp.id, { isEnabled: !mcp.isEnabled });
    } catch (err: any) {
      this.error.set(err?.error?.message || 'Failed to toggle MCP server');
    }
  }

  // ---- MCP tool discovery ----

  mcpExpandedTools = signal<string | null>(null);

  private discoverAllRemoteTools(): void {
    for (const mcp of this.mcpServers()) {
      if (mcp.serverType === 'remote' && mcp.isEnabled) {
        this.mcpConfigService.discoverTools(mcp.id);
      }
    }
  }

  toggleToolsPanel(id: string): void {
    if (this.mcpExpandedTools() === id) {
      this.mcpExpandedTools.set(null);
      return;
    }
    this.mcpExpandedTools.set(id);
    const cached = this.mcpConfigService.getToolsState(id);
    if (!cached || cached.error) {
      this.mcpConfigService.discoverTools(id);
    }
  }

  refreshTools(id: string): void {
    this.mcpConfigService.discoverTools(id);
  }

  getToolsState(id: string): { tools: McpToolInfo[]; loading: boolean; error?: string } | undefined {
    return this.mcpConfigService.getToolsState(id);
  }

  private parseArgsStr(str: string): string[] | undefined {
    const trimmed = str.trim();
    if (!trimmed) return undefined;
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }

  private parseKvLines(str: string): Record<string, string> | undefined {
    const trimmed = str.trim();
    if (!trimmed) return undefined;
    const result: Record<string, string> = {};
    for (const line of trimmed.split('\n')) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        result[line.substring(0, eqIdx).trim()] = line.substring(eqIdx + 1).trim();
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  private dictToLines(dict?: Record<string, string>): string {
    if (!dict) return '';
    return Object.entries(dict).map(([k, v]) => `${k}=${v}`).join('\n');
  }

  // ---- Artifact feeds ----

  readonly artifactFeedIconNuget = siNuget;
  readonly artifactFeedIconNpm = siNpm;
  readonly artifactFeedIconPypi = siPypi;

  artifactFeeds(): ArtifactFeedDto[] {
    return this.artifactFeedService.feeds();
  }

  openAddArtifactForm(): void {
    if (!this.authService.isAdmin()) return;
    this.artifactFormId.set(null);
    this.artifactFormName.set('');
    this.artifactFormOrg.set(this.azureDevOpsOrg() || '');
    this.artifactFormFeedName.set('');
    this.artifactFormProjectName.set('');
    this.artifactFormFeedType.set('nuget');
    this.artifactBrowseFeeds.set([]);
    this.artifactBrowseError.set(null);
    this.artifactBrowseSearchQuery.set('');
    this.artifactFormOpen.set(true);
  }

  openEditArtifactForm(feed: ArtifactFeedDto): void {
    if (!this.authService.isAdmin() || !feed.canManage) return;
    this.artifactFormId.set(feed.id);
    this.artifactFormName.set(feed.name);
    this.artifactFormOrg.set(feed.organization);
    this.artifactFormFeedName.set(feed.feedName);
    this.artifactFormProjectName.set(feed.projectName || '');
    this.artifactFormFeedType.set(feed.feedType);
    this.artifactBrowseFeeds.set([]);
    this.artifactBrowseError.set(null);
    this.artifactBrowseSearchQuery.set('');
    this.artifactFormOpen.set(true);
  }

  cancelArtifactForm(): void {
    this.artifactFormOpen.set(false);
    this.artifactFormId.set(null);
    this.artifactBrowseSearchQuery.set('');
  }

  async browseArtifactFeeds(): Promise<void> {
    const org = this.artifactFormOrg().trim();
    if (!org) return;

    this.artifactBrowseLoading.set(true);
    this.artifactBrowseError.set(null);
    this.artifactBrowseSearchQuery.set('');
    try {
      const feeds = await this.artifactFeedService.browseAzureFeeds(org);
      this.artifactBrowseFeeds.set(feeds);
    } catch (e: any) {
      this.artifactBrowseError.set(e?.error?.message || e?.message || 'Failed to browse feeds');
      this.artifactBrowseFeeds.set([]);
    } finally {
      this.artifactBrowseLoading.set(false);
    }
  }

  selectBrowsedFeed(feed: AzureDevOpsFeedDto): void {
    this.artifactFormFeedName.set(feed.name);
    this.artifactFormProjectName.set(feed.project || '');
    if (!this.artifactFormName()) {
      this.artifactFormName.set(feed.name);
    }
  }

  async saveArtifactFeed(): Promise<void> {
    if (!this.authService.isAdmin()) return;
    const id = this.artifactFormId();
    const name = this.artifactFormName().trim();
    const organization = this.artifactFormOrg().trim();
    const feedName = this.artifactFormFeedName().trim();
    const projectName = this.artifactFormProjectName().trim() || undefined;
    const feedType = this.artifactFormFeedType();

    if (!name || !organization || !feedName) {
      this.error.set('Name, organization, and feed name are required.');
      return;
    }

    this.actionLoading.set('artifact-save');
    this.error.set(null);
    try {
      if (id) {
        await this.artifactFeedService.update(id, { name, organization, feedName, projectName, feedType });
        this.successMessage.set('Artifact feed updated');
      } else {
        await this.artifactFeedService.create({ name, organization, feedName, projectName, feedType });
        this.successMessage.set('Artifact feed added');
      }
      this.cancelArtifactForm();
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err?.error?.message || err?.message || 'Failed to save artifact feed');
    } finally {
      this.actionLoading.set(null);
    }
  }

  async deleteArtifactFeed(id: string): Promise<void> {
    if (!this.authService.isAdmin()) return;
    if (!confirm('Delete this artifact feed configuration?')) return;
    this.actionLoading.set('artifact-delete');
    this.error.set(null);
    try {
      await this.artifactFeedService.delete(id);
      this.successMessage.set('Artifact feed deleted');
      setTimeout(() => this.successMessage.set(null), 3000);
    } catch (err: any) {
      this.error.set(err?.error?.message || err?.message || 'Failed to delete');
    } finally {
      this.actionLoading.set(null);
    }
  }

  async toggleArtifactFeed(feed: ArtifactFeedDto): Promise<void> {
    if (!this.authService.isAdmin() || !feed.canManage) return;
    try {
      await this.artifactFeedService.update(feed.id, { isEnabled: !feed.isEnabled });
    } catch (err: any) {
      this.error.set(err?.error?.message || 'Failed to toggle artifact feed');
    }
  }

  getFeedTypeBadgeClass(feedType: string): string {
    switch (feedType) {
      case 'nuget': return 'feed-badge--nuget';
      case 'npm': return 'feed-badge--npm';
      case 'pip': return 'feed-badge--pip';
      default: return '';
    }
  }

  feedTypeAriaLabel(feedType: string): string {
    switch (feedType) {
      case 'nuget':
        return 'NuGet';
      case 'npm':
        return 'npm';
      case 'pip':
        return 'PyPI';
      default:
        return feedType;
    }
  }

  // ---- Misc ----

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
