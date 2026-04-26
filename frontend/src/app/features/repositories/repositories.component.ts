import { Component, OnInit, OnDestroy, AfterViewInit, signal, computed, HostListener, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, firstValueFrom } from 'rxjs';
import { debounceTime, distinctUntilChanged, filter, takeUntil, switchMap } from 'rxjs/operators';
import { of } from 'rxjs';
import { ActivatedRoute, NavigationEnd, Router, RouterLink } from '@angular/router';
import { RepositoryService, SyncSource, PagedRepositoriesResult, AvailableRepoItem } from '../../core/services/repository.service';
import { LastVisitedRepositoryService } from '../../core/services/last-visited-repository.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { AnalysisService } from '../../core/services/analysis.service';
import { AuthService } from '../../core/services/auth.service';
import { VncViewerService } from '../../core/services/vnc-viewer.service';
import { SandboxService } from '../../core/services/sandbox.service';
import { AIConfigService } from '../../core/services/ai-config.service';
import { ArtifactFeedService } from '../../core/services/artifact-feed.service';
import { SandboxBridgeService } from '../../core/services/sandbox-bridge.service';
import { BacklogService, AzureDevOpsProject } from '../../core/services/backlog.service';
import { Repository } from '../../shared/models/repository.model';
import { ButtonComponent, CardComponent, GridColumn } from '../../shared/components';
import { VPS_CONFIG } from '../../core/config/vps.config';

/**
 * Component for displaying and managing repositories
 * Uses signals for reactive state management
 */
@Component({
  selector: 'app-repositories',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonComponent, CardComponent],
  templateUrl: './repositories.component.html',
  styleUrl: './repositories.component.css'
})
export class RepositoriesComponent implements OnInit, OnDestroy, AfterViewInit {
  private readonly destroy$ = new Subject<void>();
  private readonly searchSubject = new Subject<string>();
  repositories = signal<Repository[]>([]);
  loading = signal<boolean>(false);
  /** True during API refresh when the list is kept on screen (search debounce) — avoids killing focus on the search input */
  refreshingList = signal<boolean>(false);
  loadingMore = signal<boolean>(false);
  searchQuery = signal<string>('');
  page = signal<number>(1);
  pageSize = 100;
  hasMore = signal<boolean>(true);
  totalCount = signal<number>(0);
  syncing = signal<boolean>(false);
  syncingProvider = signal<string | null>(null);
  syncSources = signal<SyncSource[]>([]);
  analyzing = signal<Record<string, boolean>>({});
  creatingSandboxFor = signal<string | null>(null);
  /** Increments on each full list reload so older HTTP responses are ignored (search / filter / sync racing). */
  private listResetFetchId = 0;

  error = signal<string | null>(null);
  successMessage = signal<string | null>(null);
  showSyncMenu = signal<boolean>(false);
  showAzureDevOpsOrgPrompt = signal<boolean>(false);
  azureDevOpsOrgName = signal<string>('');
  showAddRepoModal = signal<boolean>(false);
  addRepoUrl = signal<string>('');
  addingRepo = signal<boolean>(false);
  /** New local (unpublished) project — same modal pattern as add GitHub. */
  showNewLocalModal = signal<boolean>(false);
  newLocalName = signal<string>('');
  newLocalDescription = signal<string>('');
  creatingLocal = signal<boolean>(false);
  /** Publish local project: choose GitHub or Azure, then show provider-specific form */
  publishLocalTarget = signal<Repository | null>(null);
  publishLocalStep = signal<'choose' | 'github' | 'azure' | null>(null);
  publishGhRepoName = signal<string>('');
  publishGhDescription = signal<string>('');
  publishGhOrg = signal<string>('');
  publishGhPrivate = signal<boolean>(false);
  publishingGh = signal<boolean>(false);
  publishAzOrg = signal<string>('');
  publishAzProject = signal<string>('');
  publishAzRepoName = signal<string>('');
  publishingAz = signal<boolean>(false);
  /** Azure project list (from API; org/PAT from Settings) */
  publishAzProjectList = signal<AzureDevOpsProject[]>([]);
  azProjectsLoading = signal<boolean>(false);
  viewMode = signal<'cards' | 'grid'>('cards');

  // Sync selection modal (choose which repos to sync)
  showSyncSelectModal = signal<boolean>(false);
  syncSelectProvider = signal<'GitHub' | 'AzureDevOps' | null>(null);
  availableReposForSync = signal<AvailableRepoItem[]>([]);
  selectedReposForSync = signal<Set<string>>(new Set());
  loadingAvailableRepos = signal<boolean>(false);
  syncSelectOrg = signal<string>('');
  /** Filter text in the sync modal repository list */
  syncModalRepoSearch = signal<string>('');

  filteredReposForSync = computed(() => {
    const q = this.syncModalRepoSearch().trim().toLowerCase();
    const items = this.availableReposForSync();
    if (!q) return items;
    return items.filter((i) => i.fullName.toLowerCase().includes(q));
  });

  // Share repository modal
  showShareModal = signal<boolean>(false);
  shareRepo = signal<Repository | null>(null);
  shareModalSharedWith = signal<{ userId: string; email: string; name?: string }[]>([]);
  shareModalEmail = signal<string>('');
  shareModalLoading = signal<boolean>(false);
  shareModalAdding = signal<boolean>(false);
  shareModalSuggestions = signal<{ userId: string; email: string; name?: string }[]>([]);
  private shareSuggestQuery$ = new Subject<string>();

  // Provider filter
  activeProviderTab = signal<'all' | 'GitHub' | 'AzureDevOps' | 'Unpublished'>('all');
  // Visibility filter: all repos, only mine, or only shared with me
  visibilityFilter = signal<'all' | 'mine' | 'shared'>('all');

  // AI Config status
  isAIConfigured = computed(() => this.aiConfigService.isConfigured());
  
  // Computed: check if any provider is linked
  hasLinkedProvider = computed(() => this.syncSources().some(s => s.isLinked));
  
  // Computed: filtered repositories based on provider tab (visibility filter is applied by API)
  filteredRepositories = computed(() => {
    const repos = this.repositories();
    const tab = this.activeProviderTab();
    if (tab === 'all') return repos;
    if (tab === 'Unpublished') return repos.filter((r) => r.provider === 'Unpublished');
    return repos.filter((r) => r.provider === tab);
  });

  /**
   * Bumps when returning to this route or on first load so `recentRepositories` re-reads localStorage
   * (matches current filters once the list is loaded).
   */
  private readonly lastVisitedStorageRevision = signal<number>(0);

  /** Up to 5 most recently opened repos still visible under current filters (not duplicated in project groups). */
  recentRepositories = computed(() => {
    this.lastVisitedStorageRevision();
    const orderedIds = this.lastVisited.peekOrderedIds();
    if (orderedIds.length === 0) return [];
    const byId = new Map(this.filteredRepositories().map(r => [String(r.id), r]));
    const out: Repository[] = [];
    const seen = new Set<string>();
    for (const id of orderedIds) {
      const r = byId.get(String(id));
      if (r && !seen.has(String(r.id))) {
        seen.add(String(r.id));
        out.push(r);
      }
    }
    return out;
  });

  // Computed: group repositories by project (GitHub: org, Azure DevOps: org/project)
  repositoriesByProject = computed(() => {
    const pinned = new Set(this.recentRepositories().map(r => String(r.id)));
    const repos = this.filteredRepositories().filter(r => !pinned.has(String(r.id)));
    const groups = new Map<string, Repository[]>();
    for (const repo of repos) {
      const projectKey = this.getProjectKey(repo);
      if (!groups.has(projectKey)) groups.set(projectKey, []);
      groups.get(projectKey)!.push(repo);
    }
    return Array.from(groups.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([project, items]) => ({ project, items }));
  });
  
  // Computed: repository counts per provider
  githubCount = computed(() => this.repositories().filter((r) => r.provider === 'GitHub').length);
  azureDevOpsCount = computed(() => this.repositories().filter((r) => r.provider === 'AzureDevOps').length);
  unpublishedCount = computed(() => this.repositories().filter((r) => r.provider === 'Unpublished').length);
  allCount = computed(() => this.repositories().length);

  // Grid columns configuration (will be initialized in ngOnInit)
  gridColumns: GridColumn[] = [];

  constructor(
    private repositoryService: RepositoryService,
    private analysisService: AnalysisService,
    public authService: AuthService,
    private router: Router,
    private route: ActivatedRoute,
    private vncViewerService: VncViewerService,
    private sandboxService: SandboxService,
    private aiConfigService: AIConfigService,
    private artifactFeedService: ArtifactFeedService,
    private sandboxBridgeService: SandboxBridgeService,
    private elementRef: ElementRef,
    private lastVisited: LastVisitedRepositoryService,
    private confirmDialog: ConfirmDialogService,
    private backlogService: BacklogService
  ) {}

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

    this.route.queryParams.pipe(takeUntil(this.destroy$)).subscribe(params => {
      if (params['linked']) {
        const provider = params['linked'] as string;
        const displayName = this.linkedProviderDisplayName(provider);
        this.successMessage.set(`${displayName} account linked successfully!`);
        this.loadSyncSources();
        this.router.navigate([], { relativeTo: this.route, queryParams: {} });
        setTimeout(() => this.successMessage.set(null), 5000);
      }
    });
    
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
    
    // Debounced search
    this.searchSubject.pipe(
      debounceTime(400),
      distinctUntilChanged(),
      takeUntil(this.destroy$)
    ).subscribe(() => this.loadRepositories(true, { preserveList: true }));

    // User suggestions for share modal
    this.shareSuggestQuery$.pipe(
      debounceTime(300),
      distinctUntilChanged(),
      switchMap(q => (q?.trim().length ?? 0) < 2 ? of([]) : this.repositoryService.suggestUsers(q.trim(), 10)),
      takeUntil(this.destroy$)
    ).subscribe(suggestions => {
      const sharedIds = new Set(this.shareModalSharedWith().map(u => u.userId));
      this.shareModalSuggestions.set(suggestions.filter(s => !sharedIds.has(s.userId)));
    });

    this.bumpLastVisitedRevision();
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntil(this.destroy$)
      )
      .subscribe(e => {
        if (e.urlAfterRedirects === '/repositories' || e.urlAfterRedirects.startsWith('/repositories?')) {
          this.bumpLastVisitedRevision();
        }
      });

    this.loadRepositories();
  }

  private bumpLastVisitedRevision(): void {
    this.lastVisitedStorageRevision.update(v => v + 1);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
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

  /** Derive project key for grouping: GitHub = org, Azure DevOps = org/project, Unpublished = single bucket */
  getProjectKey(repo: Repository): string {
    if (repo.provider === 'Unpublished') return 'Local';
    if (repo.provider === 'AzureDevOps') {
      const parts = repo.fullName.split('/');
      return parts.length >= 2 ? parts.slice(0, 2).join('/') : repo.organizationName;
    }
    return repo.organizationName || repo.fullName.split('/')[0] || 'Other';
  }

  /** Format project key for display: friendly name without raw org/project */
  getProjectDisplayName(projectKey: string): string {
    if (projectKey === 'Local') return 'Local (unpublished)';
    const parts = projectKey.split('/');
    const last = parts[parts.length - 1] || projectKey;
    return last
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || projectKey;
  }

  loadRepositories(reset = true, options?: { preserveList?: boolean }): void {
    const preserve =
      !!options?.preserveList &&
      reset &&
      this.repositories().length > 0 &&
      !this.loading();

    let resetFetchId = 0;
    if (reset) {
      resetFetchId = ++this.listResetFetchId;
      this.page.set(1);
      this.hasMore.set(true);
      if (preserve) {
        this.refreshingList.set(true);
      } else {
        this.refreshingList.set(false);
        this.repositories.set([]);
        this.loading.set(true);
      }
    } else {
      this.loadingMore.set(true);
    }
    this.error.set(null);

    const search = this.searchQuery().trim() || undefined;
    const page = this.page();

    const filter = this.visibilityFilter();
    this.repositoryService.getRepositoriesPaginated({
      search,
      filter: filter !== 'all' ? filter : undefined,
      page,
      pageSize: this.pageSize
    }).subscribe({
      next: (result: PagedRepositoriesResult) => {
        if (reset && resetFetchId !== this.listResetFetchId) {
          return;
        }
        this.hasMore.set(result.hasMore);
        this.totalCount.set(result.totalCount);
        if (reset) {
          this.repositories.set(result.items);
        } else {
          this.repositories.update(repos => [...repos, ...result.items]);
        }
        this.loading.set(false);
        this.loadingMore.set(false);
        this.refreshingList.set(false);
      },
      error: (err) => {
        if (reset && resetFetchId !== this.listResetFetchId) {
          return;
        }
        this.error.set(err.message || 'Failed to load repositories');
        this.loading.set(false);
        this.loadingMore.set(false);
        this.refreshingList.set(false);
      }
    });
  }

  onSearchInput(value: string): void {
    this.searchQuery.set(value);
    this.searchSubject.next(value.trim());
  }

  loadMore(): void {
    if (!this.hasMore() || this.loadingMore() || this.loading() || this.refreshingList()) return;
    this.page.update(p => p + 1);
    this.loadRepositories(false);
  }

  onRepositoriesScroll(event: Event): void {
    const el = event.target as HTMLElement;
    const threshold = 100;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold) {
      this.loadMore();
    }
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
    this.closeSyncMenu();
    this.syncSelectProvider.set('GitHub');
    this.syncSelectOrg.set('');
    this.syncModalRepoSearch.set('');
    this.availableReposForSync.set([]);
    this.selectedReposForSync.set(new Set());
    this.showSyncSelectModal.set(true);
    this.error.set(null);
    this.loadAvailableRepos();
  }

  syncFromAzureDevOps(organizationName?: string): void {
    if (organizationName?.trim()) {
      this.openAzureDevOpsSyncModal(organizationName.trim());
      return;
    }
    // Use organization from settings if available
    this.authService.getProviderSettings().subscribe({
      next: (settings) => {
        const orgFromSettings = settings.azureDevOpsOrganization?.trim();
        if (orgFromSettings) {
          this.openAzureDevOpsSyncModal(orgFromSettings);
        } else {
          this.showAzureDevOpsOrgPrompt.set(true);
        }
      },
      error: () => {
        this.showAzureDevOpsOrgPrompt.set(true);
      }
    });
  }

  private openAzureDevOpsSyncModal(organizationName: string): void {
    this.closeSyncMenu();
    this.syncSelectProvider.set('AzureDevOps');
    this.syncSelectOrg.set(organizationName);
    this.syncModalRepoSearch.set('');
    this.availableReposForSync.set([]);
    this.selectedReposForSync.set(new Set());
    this.showSyncSelectModal.set(true);
    this.error.set(null);
    this.loadAvailableRepos();
  }

  submitAzureDevOpsOrg(): void {
    const orgName = this.azureDevOpsOrgName();
    if (orgName.trim()) {
      this.showAzureDevOpsOrgPrompt.set(false);
      this.syncFromAzureDevOps(orgName.trim());
      this.azureDevOpsOrgName.set('');
    }
  }

  cancelAzureDevOpsOrgPrompt(): void {
    this.showAzureDevOpsOrgPrompt.set(false);
    this.azureDevOpsOrgName.set('');
  }

  loadAvailableRepos(): void {
    const provider = this.syncSelectProvider();
    if (!provider) return;
    this.loadingAvailableRepos.set(true);
    this.error.set(null);
    const req = provider === 'GitHub'
      ? this.repositoryService.getAvailableGitHubRepositories()
      : this.repositoryService.getAvailableAzureDevOpsRepositories(this.syncSelectOrg() || undefined);
    req.subscribe({
      next: (list) => {
        this.availableReposForSync.set(list);
        this.loadingAvailableRepos.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to load repositories');
        this.loadingAvailableRepos.set(false);
      }
    });
  }

  closeSyncSelectModal(): void {
    this.showSyncSelectModal.set(false);
    this.syncSelectProvider.set(null);
    this.availableReposForSync.set([]);
    this.selectedReposForSync.set(new Set());
    this.syncSelectOrg.set('');
    this.syncModalRepoSearch.set('');
    this.error.set(null);
  }

  selectableRepos(): AvailableRepoItem[] {
    return this.availableReposForSync().filter(r => !r.alreadyInApp);
  }

  toggleRepoSelection(fullName: string): void {
    const item = this.availableReposForSync().find(r => r.fullName === fullName);
    if (item?.alreadyInApp) return;
    this.selectedReposForSync.update(set => {
      const next = new Set(set);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  }

  selectAllRepos(): void {
    const selectable = this.filteredReposForSync()
      .filter((r) => !r.alreadyInApp)
      .map((r) => r.fullName);
    this.selectedReposForSync.set(new Set(selectable));
  }

  unselectAllRepos(): void {
    this.selectedReposForSync.set(new Set());
  }

  isRepoSelected(fullName: string): boolean {
    return this.selectedReposForSync().has(fullName);
  }

  confirmSyncSelected(): void {
    const provider = this.syncSelectProvider();
    const selected = Array.from(this.selectedReposForSync());
    if (!provider || selected.length === 0) {
      this.closeSyncSelectModal();
      return;
    }
    this.syncing.set(true);
    this.syncingProvider.set(provider);
    this.error.set(null);
    const req = provider === 'GitHub'
      ? this.repositoryService.syncSelectedGitHubRepositories(selected)
      : this.repositoryService.syncSelectedAzureDevOpsRepositories(this.syncSelectOrg(), selected);
    req.subscribe({
      next: (res) => {
        this.syncing.set(false);
        this.syncingProvider.set(null);
        this.closeSyncSelectModal();
        this.loadRepositories(true);
        this.successMessage.set(res.added === 0 ? 'No new repositories to add' : `Added ${res.added} repository(ies)`);
        setTimeout(() => this.successMessage.set(null), 3000);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to sync selected repositories');
        this.syncing.set(false);
        this.syncingProvider.set(null);
      }
    });
  }

  async deleteRepository(repo: Repository): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: `Delete “${repo.name}”?`,
      message: 'This will remove the repository and its backlog from the app.',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger'
    });
    if (!ok) {
      return;
    }
    this.repositoryService.deleteRepository(repo.id).subscribe({
      next: () => {
        this.loadRepositories(true);
        this.successMessage.set('Repository removed');
        setTimeout(() => this.successMessage.set(null), 3000);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to delete repository');
      }
    });
  }

  openShareModal(repo: Repository): void {
    this.shareRepo.set(repo);
    this.shareModalEmail.set('');
    this.shareModalSuggestions.set([]);
    this.error.set(null);
    this.showShareModal.set(true);
    this.loadShareModalData();
  }

  closeShareModal(): void {
    this.showShareModal.set(false);
    this.shareRepo.set(null);
    this.shareModalSharedWith.set([]);
    this.shareModalEmail.set('');
    this.shareModalLoading.set(false);
    this.shareModalAdding.set(false);
    this.shareModalSuggestions.set([]);
    this.error.set(null);
  }

  onShareEmailInput(value: string): void {
    this.shareModalEmail.set(value);
    this.shareSuggestQuery$.next(value);
  }

  selectShareSuggestion(suggestion: { userId: string; email: string; name?: string }): void {
    const repo = this.shareRepo();
    if (!repo) return;
    this.shareModalSuggestions.set([]);
    this.shareModalAdding.set(true);
    this.error.set(null);
    this.repositoryService.shareRepository(repo.id, suggestion.email).subscribe({
      next: () => {
        this.shareModalEmail.set('');
        this.shareModalAdding.set(false);
        this.loadShareModalData();
        this.successMessage.set('Repository shared with ' + (suggestion.name || suggestion.email));
        setTimeout(() => this.successMessage.set(null), 3000);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to share');
        this.shareModalAdding.set(false);
      }
    });
  }

  loadShareModalData(): void {
    const repo = this.shareRepo();
    if (!repo) return;
    this.shareModalLoading.set(true);
    this.repositoryService.getSharedWith(repo.id).subscribe({
      next: (res) => {
        this.shareModalSharedWith.set(res.sharedWith ?? []);
        this.shareModalLoading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to load shared users');
        this.shareModalLoading.set(false);
      }
    });
  }

  addShareByEmail(): void {
    const repo = this.shareRepo();
    const email = this.shareModalEmail().trim();
    if (!repo || !email) return;
    this.shareModalAdding.set(true);
    this.error.set(null);
    this.repositoryService.shareRepository(repo.id, email).subscribe({
      next: () => {
        this.shareModalEmail.set('');
        this.shareModalAdding.set(false);
        this.loadShareModalData();
        this.successMessage.set('Repository shared with ' + email);
        setTimeout(() => this.successMessage.set(null), 3000);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to share');
        this.shareModalAdding.set(false);
      }
    });
  }

  removeShare(sharedWithUserId: string): void {
    const repo = this.shareRepo();
    if (!repo) return;
    this.repositoryService.unshareRepository(repo.id, sharedWithUserId).subscribe({
      next: () => {
        this.loadShareModalData();
        this.successMessage.set('Access removed');
        setTimeout(() => this.successMessage.set(null), 3000);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to remove access');
      }
    });
  }

  openAddRepoModal(): void {
    this.showAddRepoModal.set(true);
    this.addRepoUrl.set('');
    this.error.set(null);
  }

  closeAddRepoModal(): void {
    this.showAddRepoModal.set(false);
    this.addRepoUrl.set('');
    this.addingRepo.set(false);
    this.error.set(null);
  }

  openNewLocalModal(): void {
    this.closeSyncMenu();
    this.showNewLocalModal.set(true);
    this.newLocalName.set('');
    this.newLocalDescription.set('');
    this.error.set(null);
  }

  closeNewLocalModal(): void {
    this.showNewLocalModal.set(false);
    this.creatingLocal.set(false);
    this.error.set(null);
  }

  submitNewLocal(): void {
    const name = this.newLocalName().trim();
    if (!name) return;
    this.creatingLocal.set(true);
    this.error.set(null);
    this.repositoryService.createUnpublishedRepository(name, this.newLocalDescription().trim() || undefined).subscribe({
      next: () => {
        this.creatingLocal.set(false);
        this.closeNewLocalModal();
        this.successMessage.set(`Created local project “${name}”`);
        this.loadRepositories(true);
        this.activeProviderTab.set('Unpublished');
        setTimeout(() => this.successMessage.set(null), 4000);
      },
      error: (err) => {
        this.creatingLocal.set(false);
        this.error.set(err.error?.message ?? err.message ?? 'Failed to create project');
      }
    });
  }

  openPublishLocalModal(repo: Repository): void {
    this.publishLocalTarget.set(repo);
    this.publishLocalStep.set('choose');
    this.error.set(null);
    this.publishAzProjectList.set([]);
  }

  closePublishLocalModal(): void {
    this.publishLocalTarget.set(null);
    this.publishLocalStep.set(null);
    this.publishingGh.set(false);
    this.publishingAz.set(false);
    this.azProjectsLoading.set(false);
    this.publishAzProjectList.set([]);
    this.error.set(null);
  }

  backPublishLocalChoose(): void {
    this.error.set(null);
    this.publishAzProjectList.set([]);
    this.publishLocalStep.set('choose');
  }

  goPublishLocalProvider(which: 'github' | 'azure'): void {
    this.error.set(null);
    const repo = this.publishLocalTarget();
    if (!repo) return;

    if (which === 'github') {
      if (!this.isProviderLinked('GitHub')) {
        this.error.set('Connect your GitHub account in Settings first.');
        return;
      }
      this.publishGhRepoName.set(this.slugFromName(repo.name));
      this.publishGhDescription.set(repo.description || '');
      this.publishGhOrg.set('');
      this.publishGhPrivate.set(false);
      this.publishLocalStep.set('github');
      return;
    }

    if (!this.isProviderLinked('AzureDevOps')) {
      this.error.set('Connect Azure DevOps and add your organization and PAT in Settings first.');
      return;
    }

    this.publishAzRepoName.set(this.slugFromName(repo.name));
    this.publishAzProject.set('');
    this.publishAzProjectList.set([]);
    this.azProjectsLoading.set(true);
    this.publishLocalStep.set('azure');
    this.authService.getProviderSettings().subscribe({
      next: (s) => {
        this.publishAzOrg.set(s.azureDevOpsOrganization?.trim() || '');
        this.loadAzureProjectsForPublish();
      },
      error: () => {
        this.publishAzOrg.set('');
        this.loadAzureProjectsForPublish();
      }
    });
  }

  private loadAzureProjectsForPublish(): void {
    this.azProjectsLoading.set(true);
    this.error.set(null);
    this.backlogService.getAzureDevOpsProjects().subscribe({
      next: (projects) => {
        this.azProjectsLoading.set(false);
        this.publishAzProjectList.set(projects);
        const first = projects[0]?.name?.trim() ?? '';
        if (first && !this.publishAzProject().trim()) {
          this.publishAzProject.set(first);
        }
      },
      error: (err) => {
        this.azProjectsLoading.set(false);
        this.publishAzProjectList.set([]);
        this.error.set(
          err.error?.message ?? err.message ?? 'Could not load Azure DevOps projects. Check organization and PAT in Settings.'
        );
      }
    });
  }

  submitPublishGitHub(): void {
    const repo = this.publishLocalTarget();
    const repoName = this.publishGhRepoName().trim();
    if (!repo || !repoName) return;
    this.publishingGh.set(true);
    this.error.set(null);
    this.repositoryService
      .publishUnpublishedToGitHub(repo.id, {
        repositoryName: repoName,
        description: this.publishGhDescription().trim() || undefined,
        isPrivate: this.publishGhPrivate(),
        organizationLogin: this.publishGhOrg().trim() || null
      })
      .subscribe({
        next: (r) => {
          this.publishingGh.set(false);
          this.closePublishLocalModal();
          this.successMessage.set(`Published to GitHub: ${r.fullName}`);
          this.loadRepositories(true);
          setTimeout(() => this.successMessage.set(null), 5000);
        },
        error: (err) => {
          this.publishingGh.set(false);
          this.error.set(err.error?.message ?? err.message ?? 'Publish failed');
        }
      });
  }

  submitPublishAzure(): void {
    const repo = this.publishLocalTarget();
    const org = this.publishAzOrg().trim();
    const project = this.publishAzProject().trim();
    const rname = this.publishAzRepoName().trim();
    if (!repo || !org || !project || !rname) return;
    this.publishingAz.set(true);
    this.error.set(null);
    this.repositoryService
      .publishUnpublishedToAzure(repo.id, { organization: org, project, repositoryName: rname })
      .subscribe({
        next: (r) => {
          this.publishingAz.set(false);
          this.closePublishLocalModal();
          this.successMessage.set(`Published to Azure DevOps: ${r.fullName}`);
          this.loadRepositories(true);
          setTimeout(() => this.successMessage.set(null), 5000);
        },
        error: (err) => {
          this.publishingAz.set(false);
          this.error.set(err.error?.message ?? err.message ?? 'Publish failed');
        }
      });
  }

  private slugFromName(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'project';
  }

  submitAddRepo(): void {
    const url = this.addRepoUrl().trim();
    if (!url) return;

    this.addingRepo.set(true);
    this.error.set(null);
    this.repositoryService.addManualGitHubRepo(url).subscribe({
      next: (result) => {
        this.addingRepo.set(false);
        this.closeAddRepoModal();
        this.successMessage.set(result.alreadyExists ? `${result.fullName} is already in your list` : `Added ${result.fullName}`);
        this.loadRepositories(true);
        setTimeout(() => this.successMessage.set(null), 4000);
      },
      error: (err) => {
        this.addingRepo.set(false);
        const msg = err.error?.message ?? err.message ?? 'Failed to add repository';
        this.error.set(msg);
      }
    });
  }

  syncFromAllProviders(): void {
    this.syncing.set(true);
    this.syncingProvider.set('all');
    this.error.set(null);
    this.closeSyncMenu();

    this.repositoryService.syncFromAllProviders().subscribe({
      next: () => {
        this.loadRepositories(true);
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

  /** Opens the sync menu so the user can choose GitHub or Azure DevOps. */
  openSyncMenuForConnect(): void {
    this.showSyncMenu.set(true);
  }

  private linkedProviderDisplayName(provider: string): string {
    const nameMap: Record<string, string> = {
      github: 'GitHub',
      azuread: 'Microsoft',
      duende: 'Duende',
    };
    return nameMap[provider.toLowerCase()] ?? provider;
  }

  /**
   * Start GitHub OAuth link from the repositories page (same as Settings → Connect with OAuth).
   * Azure DevOps still uses PAT in Settings.
   */
  async connectGitHubOAuth(event?: Event): Promise<void> {
    event?.stopPropagation();
    this.closeSyncMenu();
    this.error.set(null);
    try {
      await this.authService.loadProviderConfig();
      const cfg = this.authService.getProviderConfig('GitHub');
      if (!cfg || cfg.type !== 'BackendOAuth') {
        this.error.set('GitHub OAuth is not available. Connect from Settings or use a PAT.');
        return;
      }
      const response = await firstValueFrom(this.authService.getLinkAuthorizationUrl(cfg.name));
      if (response?.authorizationUrl) {
        window.location.href = response.authorizationUrl;
      }
    } catch (err: unknown) {
      const msg = err && typeof err === 'object' && 'message' in err ? String((err as { message?: string }).message) : 'Failed to start GitHub connection';
      this.error.set(msg);
    }
  }

  setProviderTab(tab: 'all' | 'GitHub' | 'AzureDevOps' | 'Unpublished'): void {
    this.activeProviderTab.set(tab);
  }

  toggleSharedFilter(): void {
    const next = this.visibilityFilter() === 'shared' ? 'all' : 'shared';
    this.visibilityFilter.set(next);
    this.loadRepositories(true);
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

    this.artifactFeedService.getEnabledFeeds().then((artifactFeeds) => {
      const feedsPayload = artifactFeeds.map(f => ({
        name: f.name, organization: f.organization, feedName: f.feedName,
        projectName: f.projectName, feedType: f.feedType,
      }));

      this.repositoryService.getAuthenticatedCloneUrl(repo.id).subscribe({
        next: (result) => {
          this.createSandboxWithUrl(repo, result.cloneUrl, result.archiveUrl, feedsPayload);
        },
        error: (err) => {
          console.error('Failed to get authenticated clone URL:', err);
          const repoUrl = this.buildRepoCloneUrl(repo);
          this.createSandboxWithUrl(repo, repoUrl, undefined, feedsPayload);
        }
      });
    });
  }

  private createSandboxWithUrl(repo: Repository, repoUrl: string, repoArchiveUrl?: string, artifactFeeds?: any[]): void {
    this.sandboxService.createSandbox({
      ...(repoUrl?.trim() ? { repo_url: repoUrl } : {}),
      repo_name: repo.name,
      repo_branch: repo.defaultBranch || 'main',
      repo_archive_url: repoArchiveUrl,
      artifact_feeds: artifactFeeds?.length ? artifactFeeds : undefined,
    }).subscribe({
      next: (sandbox) => {
        console.log('Sandbox created:', sandbox);
        console.log('Repo:', repo.name, 'Branch:', repo.defaultBranch);
        
        // Wait for the container services to fully start (XFCE, panel, VNC, Zed)
        setTimeout(() => {
          this.creatingSandboxFor.set(null);
          console.log('Opening VNC viewer for sandbox:', sandbox.id);

          this.vncViewerService.open(
            sandbox.id,
            `${repo.name}`,
            undefined,
            sandbox.vnc_password
          );

          setTimeout(() => {
            console.log('Triggering auto-analysis via Bridge API...');
            this.sandboxBridgeService.sendZedPrompt(
              sandbox.id,
              'Please analyze this repository. Give me an overview of the project structure, main technologies used, and any potential improvements or issues you notice.'
            ).subscribe({
              next: (result) => {
                console.log('Analysis prompt sent to Zed:', result);
              },
              error: (err) => {
                console.warn('Failed to send analysis prompt (Zed may not be ready yet):', err);
              }
            });
          }, 15000);
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
