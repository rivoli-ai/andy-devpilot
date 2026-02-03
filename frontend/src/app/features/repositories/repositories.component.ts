import { Component, OnInit, AfterViewInit, signal, computed, HostListener, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { RepositoryService, SyncSource } from '../../core/services/repository.service';
import { AnalysisService } from '../../core/services/analysis.service';
import { AuthService } from '../../core/services/auth.service';
import { VncViewerService } from '../../core/services/vnc-viewer.service';
import { SandboxService } from '../../core/services/sandbox.service';
import { AIConfigService } from '../../core/services/ai-config.service';
import { SandboxBridgeService } from '../../core/services/sandbox-bridge.service';
import { Repository } from '../../shared/models/repository.model';
import { ButtonComponent, CardComponent, BadgeComponent, DataGridComponent, GridColumn } from '../../shared/components';
import { getVncHtmlUrl, VPS_CONFIG } from '../../core/config/vps.config';

/**
 * Component for displaying and managing repositories
 * Uses signals for reactive state management
 */
@Component({
  selector: 'app-repositories',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonComponent, CardComponent, BadgeComponent, DataGridComponent],
  templateUrl: './repositories.component.html',
  styleUrl: './repositories.component.css'
})
export class RepositoriesComponent implements OnInit, AfterViewInit {
  repositories = signal<Repository[]>([]);
  loading = signal<boolean>(false);
  syncing = signal<boolean>(false);
  syncingProvider = signal<string | null>(null);
  syncSources = signal<SyncSource[]>([]);
  analyzing = signal<Record<string, boolean>>({});
  creatingSandboxFor = signal<string | null>(null);
  error = signal<string | null>(null);
  successMessage = signal<string | null>(null);
  sandboxCount = signal<number>(0);
  showSyncMenu = signal<boolean>(false);
  showAzureDevOpsOrgPrompt = signal<boolean>(false);
  azureDevOpsOrgName = signal<string>('');
  readonly MAX_SANDBOXES = 5;
  viewMode = signal<'cards' | 'grid'>('cards');
  
  // Provider filter
  activeProviderTab = signal<'all' | 'GitHub' | 'AzureDevOps'>('all');

  // AI Config status
  isAIConfigured = computed(() => this.aiConfigService.isConfigured());
  
  // Computed: check if any provider is linked
  hasLinkedProvider = computed(() => this.syncSources().some(s => s.isLinked));
  
  // Computed: filtered repositories based on active tab
  filteredRepositories = computed(() => {
    const repos = this.repositories();
    const tab = this.activeProviderTab();
    if (tab === 'all') return repos;
    return repos.filter(r => r.provider === tab);
  });
  
  // Computed: repository counts per provider
  githubCount = computed(() => this.repositories().filter(r => r.provider === 'GitHub').length);
  azureDevOpsCount = computed(() => this.repositories().filter(r => r.provider === 'AzureDevOps').length);
  allCount = computed(() => this.repositories().length);

  // Grid columns configuration (will be initialized in ngOnInit)
  gridColumns: GridColumn[] = [];

  constructor(
    private repositoryService: RepositoryService,
    private analysisService: AnalysisService,
    public authService: AuthService,
    private router: Router,
    private vncViewerService: VncViewerService,
    private sandboxService: SandboxService,
    private aiConfigService: AIConfigService,
    private sandboxBridgeService: SandboxBridgeService,
    private elementRef: ElementRef
  ) {
    // Track sandbox count
    this.vncViewerService.viewers$.subscribe(viewers => {
      this.sandboxCount.set(viewers.length);
    });
  }

  // Close dropdown when clicking outside
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.showSyncMenu()) return;
    
    const target = event.target as HTMLElement;
    const dropdown = this.elementRef.nativeElement.querySelector('.sync-dropdown');
    
    if (dropdown && !dropdown.contains(target)) {
      this.closeSyncMenu();
    }
  }

  ngOnInit(): void {
    if (!this.authService.isLoggedIn()) {
      this.router.navigate(['/login']);
      return;
    }
    
    // Load sync sources
    this.loadSyncSources();
    
    // Initialize grid columns with method references
    this.gridColumns = [
      {
        field: 'name',
        header: 'Repository Name',
        width: '250',
        sortable: true,
        filterable: true,
        groupable: true,
        resizable: true,
        pinned: 'left'
      },
      {
        field: 'organizationName',
        header: 'Organization',
        width: '200',
        sortable: true,
        filterable: true,
        groupable: true,
        resizable: true
      },
      {
        field: 'description',
        header: 'Description',
        width: '230',
        sortable: false,
        filterable: true,
        groupable: false,
        resizable: true
      },
      {
        field: 'provider',
        header: 'Provider',
        width: '140',
        sortable: true,
        filterable: true,
        groupable: true,
        resizable: true,
        cellRenderer: (value: string) => {
          if (value === 'GitHub') {
            return `<span class="provider-badge github">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              GitHub
            </span>`;
          } else if (value === 'AzureDevOps') {
            return `<span class="provider-badge azure">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22 6v12l-6 4V6l-8 2v12l-6-4V6l10-4 10 4z"/>
              </svg>
              Azure DevOps
            </span>`;
          }
          return value;
        }
      },
      {
        field: 'isPrivate',
        header: 'Visibility',
        width: '120',
        sortable: true,
        filterable: true,
        groupable: true,
        resizable: true,
        cellRenderer: (value: boolean) => {
          return value ? '<span style="color: #f59e0b;">🔒 Private</span>' : '<span style="color: #22c55e;">🌐 Public</span>';
        }
      },
      {
        field: 'defaultBranch',
        header: 'Default Branch',
        width: '150',
        sortable: true,
        filterable: true,
        groupable: false,
        resizable: true
      },
      {
        field: 'createdAt',
        header: 'Created',
        width: '150',
        sortable: true,
        filterable: false,
        groupable: false,
        resizable: true,
        cellRenderer: (value: string) => {
          if (!value) return '-';
          const date = new Date(value);
          return date.toLocaleDateString();
        },
        comparator: (a: string, b: string) => {
          return new Date(a).getTime() - new Date(b).getTime();
        }
      },
      {
        field: 'id',
        header: 'Actions',
        width: '140',
        sortable: false,
        filterable: false,
        groupable: false,
        pinned: 'right',
        cellRenderer: (value: string, row: Repository) => {
          return this.renderActionsCell(row);
        }
      }
    ];
    
    this.loadRepositories();
  }

  private renderActionsCell(row: Repository): string {
    // Use inline styles for SVG since innerHTML doesn't inherit CSS properly
    const iconStyle = 'width:16px;height:16px;';
    const primaryIconColor = '#ffffff';
    const secondaryIconColor = '#64748b';
    
    return `
      <div class="grid-actions-inline">
        <a href="/backlog/${row.id}" class="grid-icon-btn primary" data-repo-id="${row.id}" data-action="backlog" title="View Backlog">
          <svg style="${iconStyle}" viewBox="0 0 24 24" fill="none" stroke="${primaryIconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"/>
            <line x1="8" y1="12" x2="21" y2="12"/>
            <line x1="8" y1="18" x2="21" y2="18"/>
            <line x1="3" y1="6" x2="3.01" y2="6"/>
            <line x1="3" y1="12" x2="3.01" y2="12"/>
            <line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
        </a>
        <a href="/code/${row.id}" class="grid-icon-btn" data-repo-id="${row.id}" data-action="code" title="View Code">
          <svg style="${iconStyle}" viewBox="0 0 24 24" fill="none" stroke="${secondaryIconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6"/>
            <polyline points="8 6 2 12 8 18"/>
          </svg>
        </a>
      </div>
    `;
  }

  loadRepositories(): void {
    this.loading.set(true);
    this.error.set(null);

    this.repositoryService.getRepositories().subscribe({
      next: (repos) => {
        this.repositories.set(repos);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.message || 'Failed to load repositories');
        this.loading.set(false);
      }
    });
  }

  loadSyncSources(): void {
    this.repositoryService.getSyncSources().subscribe({
      next: (sources) => {
        this.syncSources.set(sources);
      },
      error: (err) => {
        console.warn('Failed to load sync sources:', err);
      }
    });
  }

  isProviderLinked(provider: string): boolean {
    return this.syncSources().some(s => s.provider === provider && s.isLinked);
  }

  getProviderUsername(provider: string): string | null {
    const source = this.syncSources().find(s => s.provider === provider);
    return source?.username || null;
  }

  toggleSyncMenu(): void {
    this.showSyncMenu.update(v => !v);
  }

  closeSyncMenu(): void {
    this.showSyncMenu.set(false);
  }

  syncFromGitHub(): void {
    this.syncing.set(true);
    this.syncingProvider.set('GitHub');
    this.error.set(null);
    this.closeSyncMenu();

    this.repositoryService.syncFromGitHub().subscribe({
      next: (repos) => {
        this.repositories.set(repos);
        this.syncing.set(false);
        this.syncingProvider.set(null);
        this.successMessage.set('Repositories synced from GitHub');
        setTimeout(() => this.successMessage.set(null), 3000);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to sync repositories from GitHub');
        this.syncing.set(false);
        this.syncingProvider.set(null);
      }
    });
  }

  syncFromAzureDevOps(organizationName?: string): void {
    // If no organization provided, show prompt
    if (!organizationName) {
      this.showAzureDevOpsOrgPrompt.set(true);
      return;
    }
    
    this.syncing.set(true);
    this.syncingProvider.set('AzureDevOps');
    this.error.set(null);
    this.closeSyncMenu();

    this.repositoryService.syncFromAzureDevOps(organizationName).subscribe({
      next: (response: any) => {
        // Check if response indicates we need organization name
        if (response?.requiresOrganization) {
          this.syncing.set(false);
          this.syncingProvider.set(null);
          this.showAzureDevOpsOrgPrompt.set(true);
          return;
        }
        
        const repos = Array.isArray(response) ? response : response?.repositories || [];
        if (repos.length > 0) {
          this.loadRepositories(); // Reload all repos
          this.successMessage.set(`Synced ${repos.length} repositories from Azure DevOps`);
          setTimeout(() => this.successMessage.set(null), 3000);
        } else if (!organizationName) {
          // No repos found and no organization specified - prompt for org name
          this.showAzureDevOpsOrgPrompt.set(true);
        } else {
          this.successMessage.set('No repositories found in the specified organization');
          setTimeout(() => this.successMessage.set(null), 3000);
        }
        this.syncing.set(false);
        this.syncingProvider.set(null);
      },
      error: (err) => {
        const errorMsg = err.error?.message || err.message || 'Failed to sync repositories from Azure DevOps';
        
        // If authentication failed, prompt for config
        if (errorMsg.includes('authentication failed')) {
          this.syncing.set(false);
          this.syncingProvider.set(null);
          if (organizationName) this.azureDevOpsOrgName.set(organizationName);
          this.error.set('Authentication failed. Please configure Azure DevOps in Settings with a valid PAT.');
          this.showAzureDevOpsOrgPrompt.set(true);
          return;
        }
        
        this.error.set(errorMsg);
        this.syncing.set(false);
        this.syncingProvider.set(null);
      }
    });
  }

  submitAzureDevOpsOrg(): void {
    const orgName = this.azureDevOpsOrgName();
    if (orgName.trim()) {
      this.showAzureDevOpsOrgPrompt.set(false);
      this.syncFromAzureDevOps(orgName.trim());
    }
  }

  cancelAzureDevOpsOrgPrompt(): void {
    this.showAzureDevOpsOrgPrompt.set(false);
    this.azureDevOpsOrgName.set('');
  }

  syncFromAllProviders(): void {
    this.syncing.set(true);
    this.syncingProvider.set('all');
    this.error.set(null);
    this.closeSyncMenu();

    this.repositoryService.syncFromAllProviders().subscribe({
      next: () => {
        this.loadRepositories(); // Reload to get all repos
        this.syncing.set(false);
        this.syncingProvider.set(null);
        this.successMessage.set('Repositories synced from all providers');
        setTimeout(() => this.successMessage.set(null), 3000);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to sync repositories');
        this.syncing.set(false);
        this.syncingProvider.set(null);
      }
    });
  }

  navigateToSettings(): void {
    this.router.navigate(['/settings']);
  }

  setProviderTab(tab: 'all' | 'GitHub' | 'AzureDevOps'): void {
    this.activeProviderTab.set(tab);
  }

  /**
   * Analyze repository - creates a new isolated sandbox container
   */
  analyzeRepository(repositoryId: string): void {
    // Check if AI is configured
    if (!this.isAIConfigured()) {
      this.router.navigate(['/settings']);
      return;
    }
    this.openSandbox(repositoryId);
  }

  /**
   * Open a new isolated sandbox container with the repository
   */
  openSandbox(repositoryId: string): void {
    const repo = this.repositories().find(r => r.id === repositoryId);
    if (!repo) {
      this.error.set('Repository not found');
      return;
    }

    this.creatingSandboxFor.set(repositoryId);
    this.error.set(null);

    // Get AI config
    const aiConfig = this.aiConfigService.defaultProvider();
    const zedSettings = this.aiConfigService.getZedSettingsJson();

    // Fetch authenticated clone URL (with PAT embedded for private repos)
    this.repositoryService.getAuthenticatedCloneUrl(repo.id).subscribe({
      next: (result) => {
        console.log('=== Sandbox Request ===');
        console.log('Repo URL:', result.cloneUrl);
        console.log('Repo Name:', repo.name);
        console.log('Repo Branch:', repo.defaultBranch || 'main');
        console.log('AI Provider:', aiConfig.provider);
        console.log('AI Model:', aiConfig.model);
        console.log('Zed Settings:', JSON.stringify(zedSettings, null, 2));

        this.createSandboxWithUrl(repo, result.cloneUrl, aiConfig, zedSettings);
      },
      error: (err) => {
        console.error('Failed to get authenticated clone URL:', err);
        // Fallback to regular clone URL
        const repoUrl = this.buildRepoCloneUrl(repo);
        this.createSandboxWithUrl(repo, repoUrl, aiConfig, zedSettings);
      }
    });
  }

  private createSandboxWithUrl(repo: Repository, repoUrl: string, aiConfig: any, zedSettings: object): void {
    // Create sandbox with repo and AI config
    this.sandboxService.createSandbox({
      repo_url: repoUrl,
      repo_name: repo.name,
      repo_branch: repo.defaultBranch || 'main',
      ai_config: {
        provider: aiConfig.provider,
        api_key: aiConfig.apiKey,
        model: aiConfig.model,
        base_url: aiConfig.baseUrl
      },
      zed_settings: zedSettings
    }).subscribe({
      next: (sandbox) => {
        console.log('Sandbox created:', sandbox);
        console.log('Repo:', repo.name, 'Branch:', repo.defaultBranch);
        
        // Wait for the container services to fully start (XFCE, panel, VNC, Zed)
        setTimeout(() => {
          this.creatingSandboxFor.set(null);
          console.log('Opening VNC viewer for sandbox:', sandbox.id);
          console.log('Bridge port:', sandbox.bridge_port);
          
          // Open VNC viewer with the sandbox's unique port, ID, and bridge port
          // Always use getVncHtmlUrl to build the correct URL with proper IP
          // (sandbox.url from API contains placeholder 'HOST_IP')
          this.vncViewerService.open(
            {
              url: getVncHtmlUrl(sandbox.port),
              autoConnect: true,
              scalingMode: 'local',
              useIframe: true
            },
            sandbox.id,
            `${repo.name}`,
            sandbox.bridge_port
          );
          
          // Trigger auto-analysis via Bridge API after Zed has time to start
          if (sandbox.bridge_port) {
            setTimeout(() => {
              console.log('Triggering auto-analysis via Bridge API...');
              this.sandboxBridgeService.sendZedPrompt(
                sandbox.bridge_port!,
                'Please analyze this repository. Give me an overview of the project structure, main technologies used, and any potential improvements or issues you notice.'
              ).subscribe({
                next: (result) => {
                  console.log('Analysis prompt sent to Zed:', result);
                },
                error: (err) => {
                  console.warn('Failed to send analysis prompt (Zed may not be ready yet):', err);
                }
              });
            }, 15000); // Wait for Zed to fully initialize
          }
        }, VPS_CONFIG.sandboxReadyDelayMs);
      },
      error: (err) => {
        console.warn('Sandbox API error:', err);
        this.creatingSandboxFor.set(null);
        this.error.set('Failed to create sandbox. Check if the sandbox API is running.');
      }
    });
  }

  /**
   * Build the clone URL for a repository
   */
  private buildRepoCloneUrl(repo: Repository): string {
    // Use the stored cloneUrl if available
    if (repo.cloneUrl) {
      return repo.cloneUrl;
    }
    // Fallback: build HTTPS URL
    return `https://github.com/${repo.organizationName}/${repo.name}.git`;
  }
  
  /**
   * Check if sandbox is being created for a specific repository
   */
  isCreatingSandbox(repositoryId: string): boolean {
    return this.creatingSandboxFor() === repositoryId;
  }

  isAnalyzing(repositoryId: string): boolean {
    return this.analyzing()[repositoryId] || false;
  }

  /**
   * Close all open sandboxes
   */
  closeAllSandboxes(): void {
    this.vncViewerService.closeAll();
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  toggleViewMode(): void {
    this.viewMode.set(this.viewMode() === 'cards' ? 'grid' : 'cards');
  }

  onGridRowClick(repo: Repository): void {
    // Default: navigate to backlog
    this.router.navigate(['/backlog', repo.id]);
  }

  onGridRowDoubleClick(repo: Repository): void {
    this.analyzeRepository(repo.id);
  }

  ngAfterViewInit(): void {
    // Handle clicks on rendered HTML in grid cells
    setTimeout(() => {
      document.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        const actionBtn = target.closest('[data-action]') as HTMLElement;
        
        if (actionBtn) {
          // Check if button is disabled
          if (actionBtn.hasAttribute('disabled') || actionBtn.classList.contains('disabled')) {
            return;
          }
          
          // Only prevent default for links, not buttons
          if (actionBtn.tagName === 'A') {
            event.preventDefault();
          }
          event.stopPropagation();
          
          const action = actionBtn.getAttribute('data-action');
          const repoId = actionBtn.getAttribute('data-repo-id');
          
          if (!repoId || !action) {
            return;
          }
          
          if (action === 'analyze') {
            this.analyzeRepository(repoId);
          } else if (action === 'backlog') {
            this.router.navigate(['/backlog', repoId]);
          } else if (action === 'code') {
            this.router.navigate(['/code', repoId]);
          }
        }
      }, { capture: true }); // Use capture phase to catch events earlier
    }, 100);
  }
}
