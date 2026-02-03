import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { AuthService, LinkedProvider, User, ProviderSettings } from '../../core/services/auth.service';
import { CardComponent } from '../../shared/components';
import { firstValueFrom } from 'rxjs';

/**
 * Settings page for managing linked providers and account settings
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, CardComponent],
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

  // AI Configuration
  aiProvider = signal<'openai' | 'anthropic' | 'ollama' | 'custom'>('openai');
  aiApiKey = signal<string>('');
  aiModel = signal<string>('gpt-4o');
  aiBaseUrl = signal<string>('');
  showAiApiKey = signal<boolean>(false);
  hasAiApiKey = signal<boolean>(false);

  constructor(
    private authService: AuthService,
    private router: Router,
    private route: ActivatedRoute
  ) {}

  ngOnInit(): void {
    // Check if user is logged in
    if (!this.authService.isLoggedIn()) {
      this.router.navigate(['/login']);
      return;
    }

    this.user.set(this.authService.getCurrentUser());
    this.loadLinkedProviders();
    this.loadProviderSettings();

    // Check for success message from OAuth callback
    this.route.queryParams.subscribe(params => {
      if (params['linked']) {
        const provider = params['linked'] === 'github' ? 'GitHub' : 
                        params['linked'] === 'azure-devops' ? 'Azure DevOps' : params['linked'];
        this.successMessage.set(`${provider} account linked successfully!`);
        // Clear the query param
        this.router.navigate([], { queryParams: {} });
        // Clear message after 5 seconds
        setTimeout(() => this.successMessage.set(null), 5000);
      }
    });
  }

  async loadProviderSettings(): Promise<void> {
    try {
      const settings = await firstValueFrom(this.authService.getProviderSettings());
      if (settings.azureDevOpsOrganization) {
        this.azureDevOpsOrg.set(settings.azureDevOpsOrganization);
      }
      this.hasAzureDevOpsPat.set(settings.hasAzureDevOpsPat);
    } catch (err) {
      console.error('Failed to load provider settings:', err);
    }

    // Load AI settings
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

  async saveAzureDevOpsSettings(): Promise<void> {
    this.actionLoading.set('azure-settings');
    this.error.set(null);
    
    try {
      const org = this.azureDevOpsOrg().trim() || undefined;
      const pat = this.azureDevOpsPat().trim() || undefined;
      
      await firstValueFrom(this.authService.saveAzureDevOpsSettings(org, pat));
      
      // Clear the PAT input field after saving (we don't show stored PATs)
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

  // AI Configuration Methods
  setAiProvider(provider: 'openai' | 'anthropic' | 'ollama' | 'custom'): void {
    this.aiProvider.set(provider);
    // Set default model for provider
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
      
      // Clear the API key input field after saving
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
    return this.linkedProviders().some(p => p.provider === provider);
  }

  getProviderUsername(provider: string): string | null {
    const linked = this.linkedProviders().find(p => p.provider === provider);
    return linked?.providerUsername || null;
  }

  getProviderLinkedDate(provider: string): string | null {
    const linked = this.linkedProviders().find(p => p.provider === provider);
    if (linked?.linkedAt) {
      return new Date(linked.linkedAt).toLocaleDateString();
    }
    return null;
  }

  async linkGitHub(): Promise<void> {
    this.actionLoading.set('github');
    this.error.set(null);
    try {
      const response = await firstValueFrom(this.authService.getGitHubLinkAuthorizationUrl());
      if (response?.authorizationUrl) {
        window.location.href = response.authorizationUrl;
      }
    } catch (err: any) {
      this.error.set(err.error?.message || 'Failed to initiate GitHub linking');
      this.actionLoading.set(null);
    }
  }

  async linkAzureDevOps(): Promise<void> {
    this.actionLoading.set('azure-devops');
    this.error.set(null);
    try {
      const response = await firstValueFrom(this.authService.getAzureDevOpsLinkAuthorizationUrl());
      if (response?.authorizationUrl) {
        window.location.href = response.authorizationUrl;
      }
    } catch (err: any) {
      this.error.set(err.error?.message || 'Failed to initiate Azure DevOps linking');
      this.actionLoading.set(null);
    }
  }

  async unlinkProvider(provider: string): Promise<void> {
    if (!confirm(`Are you sure you want to unlink ${provider}? You will need to reconnect to sync repositories from this provider.`)) {
      return;
    }

    this.actionLoading.set(provider.toLowerCase());
    this.error.set(null);
    try {
      await firstValueFrom(this.authService.unlinkProvider(provider));
      this.successMessage.set(`${provider} unlinked successfully`);
      await this.loadLinkedProviders();
      setTimeout(() => this.successMessage.set(null), 5000);
    } catch (err: any) {
      this.error.set(err.error?.message || `Failed to unlink ${provider}`);
    } finally {
      this.actionLoading.set(null);
    }
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
