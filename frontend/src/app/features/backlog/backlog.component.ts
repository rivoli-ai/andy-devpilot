import { Component, OnInit, OnDestroy, signal, computed, effect, HostListener, ElementRef, SecurityContext } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { BacklogService, AzureDevOpsWorkItem, AzureDevOpsWorkItemsHierarchy, AzureDevOpsProject, AzureDevOpsTeam, GitHubIssue, GitHubMilestone, GitHubIssuesHierarchy, STANDALONE_EPIC_TITLE, AzureSyncPlanItemResponse, AzureSyncDirection } from '../../core/services/backlog.service';
import { RepositoryService, DEFAULT_AGENT_RULES } from '../../core/services/repository.service';
import { Repository } from '../../shared/models/repository.model';
import { SandboxService } from '../../core/services/sandbox.service';
import { SandboxBridgeService, ZedConversation } from '../../core/services/sandbox-bridge.service';
import { VncViewerService } from '../../core/services/vnc-viewer.service';
import { AIConfigService } from '../../core/services/ai-config.service';
import { McpConfigService } from '../../core/services/mcp-config.service';
import { ArtifactFeedService } from '../../core/services/artifact-feed.service';
import { AuthService } from '../../core/services/auth.service';
import { VPS_CONFIG } from '../../core/config/vps.config';
import { Epic } from '../../shared/models/epic.model';
import { Feature } from '../../shared/models/feature.model';
import { UserStory } from '../../shared/models/user-story.model';
import { AddBacklogItemModalComponent, AddItemType, EditItemData } from '../../components/add-backlog-item-modal/add-backlog-item-modal.component';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe';
import { Subject, interval, takeUntil, filter, switchMap, forkJoin, EMPTY, catchError } from 'rxjs';

type WorkItemType = 'epic' | 'feature' | 'story';
type ViewMode = 'tree' | 'flat';

interface ExpandedState {
  [key: string]: boolean;
}

/**
 * Component for displaying and managing backlog (Epics, Features, User Stories)
 * Designed like Azure DevOps / Jira backlog view
 */
@Component({
  selector: 'app-backlog',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, AddBacklogItemModalComponent, MarkdownPipe],
  templateUrl: './backlog.component.html',
  styleUrl: './backlog.component.css'
})
export class BacklogComponent implements OnInit, OnDestroy {
  /** Add/edit epic/feature/story modals are desktop-only (same breakpoint as flat view / VNC mobile) */
  private static readonly BACKLOG_CRUD_FORMS_MEDIA = '(max-width: 768px)';
  private static readonly AZURE_IDENTITY_WARNING_DISMISS_STORAGE_PREFIX = 'devpilot.dismissAzureIdentityWarning:';

  epics = signal<Epic[]>([]);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);
  repositoryId = signal<string>('');
  repositoryName = signal<string>('');
  repository = signal<Repository | null>(null);

  // Agent rules editor
  showRulesModal = signal<boolean>(false);
  rulesEditText = signal<string>('');
  rulesIsDefault = signal<boolean>(true);
  rulesSaving = signal<boolean>(false);
  rulesLoading = signal<boolean>(false);
  /** Markdown preview vs raw edit */
  rulesViewMode = signal<'preview' | 'edit'>('preview');

  // Azure Identity (sandbox Service Principal)
  showAzureIdentityModal = signal<boolean>(false);
  azureIdentityClientId = signal<string>('');
  azureIdentityClientSecret = signal<string>('');
  azureIdentityTenantId = signal<string>('');
  azureIdentityHasSecret = signal<boolean>(false);
  azureIdentityLoading = signal<boolean>(false);
  azureIdentitySaving = signal<boolean>(false);
  azureIdentityError = signal<string | null>(null);
  azureIdentityVerifying = signal<boolean>(false);
  azureIdentityVerifySuccess = signal<string | null>(null);
  azureIdentityVerifyError = signal<string | null>(null);
  /** Session dismiss for “configure Azure Identity” banner (per repository). */
  azureIdentityWarningDismissed = signal<boolean>(false);

  // Lightbox
  lightboxImageSrc: string | null = null;
  
  // Backlog generation state
  generationState = signal<'idle' | 'creating_sandbox' | 'waiting_sandbox' | 'sending' | 'waiting_response' | 'parsing' | 'saving' | 'complete' | 'error'>('idle');
  generationError = signal<string | null>(null);
  latestResponse = signal<ZedConversation | null>(null);
  promptMode = signal<'general' | 'custom'>('general');
  customInstructions = signal<string>('');
  customPrompt = signal<string>('');
  showGeneratePromptModal = signal<boolean>(false);

  // Add item modal state
  addModalType = signal<AddItemType | null>(null);
  addModalParentId = signal<string | null>(null); // epicId for feature, featureId for story
  editModalData = signal<EditItemData | null>(null); // For edit mode
  /** False on narrow viewports — do not open add/edit backlog item UI */
  backlogCrudFormsAllowed = signal<boolean>(
    typeof matchMedia === 'undefined'
      ? true
      : !matchMedia(BacklogComponent.BACKLOG_CRUD_FORMS_MEDIA).matches
  );
  private backlogCrudMql?: MediaQueryList;
  private readonly onBacklogCrudMediaChange = (): void => this.applyBacklogCrudFormsAllowedFromMedia();

  // Delete confirmation modal state
  deleteConfirmation = signal<{ type: 'epic' | 'feature' | 'story'; id: string; parentId?: string; title: string } | null>(null);
  bulkDeleteConfirmation = signal<{ epicIds: string[]; featureIds: string[]; storyIds: string[] } | null>(null);
  bulkDeleteLoading = signal<boolean>(false);

  // Azure DevOps import state
  showAzureDevOpsImport = signal<boolean>(false);
  azureDevOpsLoading = signal<boolean>(false);
  azureDevOpsError = signal<string | null>(null);
  azureDevOpsWorkItems = signal<AzureDevOpsWorkItemsHierarchy | null>(null);
  azureDevOpsOrg = signal<string>('');
  azureDevOpsProject = signal<string>('');
  azureDevOpsProjects = signal<AzureDevOpsProject[]>([]);
  azureDevOpsProjectsLoading = signal<boolean>(false);
  azureDevOpsTeam = signal<string>('');
  azureDevOpsTeams = signal<AzureDevOpsTeam[]>([]);
  azureDevOpsTeamsLoading = signal<boolean>(false);
  selectedAzureDevOpsEpics = signal<Set<number>>(new Set());
  selectedAzureDevOpsFeatures = signal<Set<number>>(new Set());
  selectedAzureDevOpsStories = signal<Set<number>>(new Set());
  expandedAzureDevOpsItems = signal<Set<number>>(new Set());
  azureDevOpsImporting = signal<boolean>(false);
  adoShowAllStatuses = signal<boolean>(false);
  adoNameFilter = signal<string>('');

  // Sync to GitHub state
  syncToGitHubLoading = signal<boolean>(false);
  syncToGitHubError = signal<string | null>(null);
  syncToGitHubSuccess = signal<{ syncedCount: number; failedCount: number } | null>(null);
  selectedSyncToAzureEpics = signal<Set<string>>(new Set());
  selectedSyncToAzureFeatures = signal<Set<string>>(new Set());
  selectedSyncToAzureStories = signal<Set<string>>(new Set());

  /** Unified Azure sync: plan per-item direction, then create / pull / push. */
  showAzureSyncModal = signal<boolean>(false);
  azureSyncStep = signal<'target' | 'plan' | 'loading'>('target');
  /** True when we skipped project/team because every selected row already had an Azure work item id. */
  azureSyncSkippedTarget = signal<boolean>(false);
  azureSyncOrg = signal<string>('');
  azureSyncProject = signal<string>('');
  azureSyncTeamId = signal<string>('');
  azureSyncProjects = signal<AzureDevOpsProject[]>([]);
  azureSyncTeams = signal<AzureDevOpsTeam[]>([]);
  azureSyncProjectsLoading = signal<boolean>(false);
  azureSyncTeamsLoading = signal<boolean>(false);
  azureSyncModalError = signal<string | null>(null);
  azureSyncPlanLoading = signal<boolean>(false);
  azureSyncApplyLoading = signal<boolean>(false);
  azureSyncPlanRows = signal<Array<AzureSyncPlanItemResponse & { direction: AzureSyncDirection }>>([]);
  /** Server-suggested counts before user changes per-row direction (plan step). */
  azureSyncPlanSuggestedSummary = signal<{ create: number; push: number; pull: number } | null>(null);
  azureSyncBannerError = signal<string | null>(null);
  azureSyncBannerSuccess = signal<{
    createdCount: number;
    pulledCount: number;
    pushedCount: number;
    failedCount: number;
  } | null>(null);

  // GitHub import state
  showGitHubImport = signal<boolean>(false);
  gitHubLoading = signal<boolean>(false);
  gitHubError = signal<string | null>(null);
  gitHubIssues = signal<GitHubIssuesHierarchy | null>(null);
  selectedGitHubIssues = signal<Set<number>>(new Set()); // Individual issue selection (like ADO)
  expandedGitHubMilestones = signal<Set<number>>(new Set());
  gitHubImporting = signal<boolean>(false);
  ghNameFilter = signal<string>('');
  ghShowAllStatuses = signal<boolean>(false); // false = Active only (open) by default, true = All

  private destroy$ = new Subject<void>();
  private lastConversationId: string | null = null;
  private createdSandboxId: string | null = null;
  
  // UI State
  expandedItems = signal<ExpandedState>({});
  searchQuery = signal<string>('');
  statusFilter = signal<string>('all');
  viewMode = signal<ViewMode>('tree');
  /** Narrow screens only show the flat list; tree is desktop-only. */
  effectiveViewMode = computed<ViewMode>(() =>
    this.backlogCrudFormsAllowed() ? this.viewMode() : 'flat'
  );
  selectedItemId = signal<string | null>(null);
  
  // Sandbox state
  creatingSandboxForStory = signal<string | null>(null);

  // LLM selector (repo override, same UI as branch dropdown)
  repoLlmUpdating = signal<boolean>(false);
  showLlmDropdown = signal<boolean>(false);
  openSandboxStoryIds = signal<string[]>([]);

  // Computed stats (exclude Standalone epic from count – it's not shown as an epic row)
  totalEpics = computed(() => this.filteredEpicsForTree().length);
  totalFeatures = computed(() => 
    this.epics().reduce((sum, epic) => sum + epic.features.length, 0)
  );
  totalStories = computed(() => 
    this.epics().reduce((sum, epic) => 
      sum + epic.features.reduce((fSum, feature) => fSum + feature.userStories.length, 0), 0
    )
  );

  epicOptionsForModal = computed(() =>
    this.epics().map(e => ({ id: e.id, title: e.title }))
  );

  featureOptionsForModal = computed(() =>
    this.epics().flatMap(epic =>
      epic.features.map(f => ({
        id: f.id,
        title: f.title,
        epicTitle: epic.title
      }))
    )
  );

  /** Live counts in the unified Azure sync plan step (by chosen direction per row). */
  azureSyncPlanCounts = computed(() => {
    let create = 0;
    let push = 0;
    let pull = 0;
    for (const r of this.azureSyncPlanRows()) {
      if (r.direction === 'create') create++;
      else if (r.direction === 'pull') pull++;
      else push++;
    }
    return { create, push, pull };
  });

  hasAzureDevOpsImportedItems = computed(() => {
    const epics = this.epics();
    for (const epic of epics) {
      if (epic.source === 'AzureDevOps' && epic.azureDevOpsWorkItemId) return true;
      for (const feature of epic.features || []) {
        if (feature.source === 'AzureDevOps' && feature.azureDevOpsWorkItemId) return true;
        for (const story of feature.userStories || []) {
          if (story.source === 'AzureDevOps' && story.azureDevOpsWorkItemId) return true;
        }
      }
    }
    return false;
  });

  /** True when backlog has any item with source GitHub (used to enable Sync to GitHub button). */
  hasGitHubImportedItems = computed(() => {
    const epics = this.epics();
    for (const epic of epics) {
      for (const feature of epic.features || []) {
        if (feature.source === 'GitHub') return true;
        for (const story of feature.userStories || []) {
          if (story.source === 'GitHub') return true;
        }
      }
    }
    return false;
  });

  hasSyncSelection = computed(() => {
    return this.selectedSyncToAzureEpics().size > 0 ||
      this.selectedSyncToAzureFeatures().size > 0 ||
      this.selectedSyncToAzureStories().size > 0;
  });

  totalStoryPoints = computed(() => 
    this.epics().reduce((sum, epic) => 
      sum + epic.features.reduce((fSum, feature) => 
        fSum + feature.userStories.reduce((sSum, story) => sSum + (story.storyPoints || 0), 0), 0
      ), 0
    )
  );
  
  // Global backlog progress (average of all stories)
  backlogProgress = computed(() => {
    const allStories = this.epics().flatMap(epic => 
      epic.features.flatMap(feature => feature.userStories)
    );
    if (allStories.length === 0) return 0;
    const totalProgress = allStories.reduce((sum, story) => 
      sum + this.getStatusPercentage(this.getEffectiveStoryStatus(story)), 0
    );
    return Math.round(totalProgress / allStories.length);
  }
  );

  // Generation steps for waiting room (single source of truth)
  generationSteps = computed(() => [
    { id: 'creating_sandbox', order: 1, label: 'Sandbox', title: 'Creating Sandbox Environment', description: 'Setting up isolated container with your repository' },
    { id: 'waiting_sandbox', order: 2, label: 'Zed IDE', title: 'Starting Zed IDE', description: 'Waiting for the AI agent to be ready' },
    { id: 'sending', order: 3, label: 'Prompt', title: 'Sending Prompt to Zed', description: 'Preparing the backlog generation request' },
    { id: 'waiting_response', order: 4, label: 'AI', title: 'AI is Analyzing Your Repository', description: 'The AI is analyzing your codebase and generating the backlog. This may take a minute.' },
    { id: 'parsing', order: 5, label: 'Parse', title: 'Parsing Backlog', description: 'Extracting structured backlog from AI response' },
    { id: 'saving', order: 6, label: 'Save', title: 'Saving Backlog', description: 'Saving the generated backlog to database' }
  ]);

  currentStepId = computed(() => this.generationState());
  currentStepOrder = computed(() => {
    const state = this.generationState();
    const step = this.generationSteps().find(s => s.id === state);
    return step?.order ?? 0;
  });
  currentStepLabel = computed(() => {
    const state = this.generationState();
    const step = this.generationSteps().find(s => s.id === state);
    return step?.label ?? '';
  });
  currentStepTitle = computed(() => {
    const state = this.generationState();
    const step = this.generationSteps().find(s => s.id === state);
    return step?.title ?? '';
  });
  currentStepDescription = computed(() => {
    const state = this.generationState();
    const step = this.generationSteps().find(s => s.id === state);
    return step?.description ?? '';
  });

  // Filtered epics based on search and status filter
  // Status filter applies to user stories, not epics
  filteredEpics = computed(() => {
    const query = this.searchQuery().toLowerCase();
    const status = this.statusFilter();
    
    if (!query && status === 'all') return this.epics();
    
    // Filter epics that have matching stories
    return this.epics()
      .map(epic => {
        // Filter features that have matching stories
        const filteredFeatures = epic.features
          .map(feature => {
            // Filter stories by status
            const filteredStories = feature.userStories.filter(story => {
              const matchesSearch = !query || 
                story.title.toLowerCase().includes(query) ||
                story.description?.toLowerCase().includes(query) ||
                feature.title.toLowerCase().includes(query) ||
                epic.title.toLowerCase().includes(query);
              
              const effectiveStatus = this.getEffectiveStoryStatus(story);
              const matchesStatus = status === 'all' || 
                this.normalizeStatus(effectiveStatus) === status.toLowerCase();
              
              return matchesSearch && matchesStatus;
            });
            
            // Only include feature if it has matching stories
            if (filteredStories.length > 0) {
              return { ...feature, userStories: filteredStories };
            }
            return null;
          })
          .filter((f): f is Feature => f !== null);
        
        // Only include epic if it has matching features
        if (filteredFeatures.length > 0) {
          return { ...epic, features: filteredFeatures };
        }
        return null;
      })
      .filter((e): e is Epic => e !== null);
  });

  // Epics for tree view (excludes Standalone - standalone items render separately without epic)
  filteredEpicsForTree = computed(() =>
    this.filteredEpics().filter(e => e.title !== STANDALONE_EPIC_TITLE)
  );

  /** True when there is any content to show (tree epics, or standalone features/stories). Used for empty state. */
  hasAnyBacklogItems = computed(() =>
    this.filteredEpicsForTree().length > 0 ||
    this.standaloneFeaturesForTree().length > 0 ||
    this.standaloneStoriesForTree().length > 0
  );

  /** True when backlog has any raw data (before filtering). Keeps stats bar + filters visible when filter yields 0 items. */
  hasRawBacklogItems = computed(() => this.epics().length > 0);

  // Standalone epic (used for deleteFeature parent - never displayed)
  standaloneEpic = computed(() =>
    this.epics().find(e => e.title === STANDALONE_EPIC_TITLE)
  );

  // Features without epic - display as Feature → Stories (no epic row)
  standaloneFeaturesForTree = computed(() => {
    const epic = this.standaloneEpic();
    if (!epic) return [];
    return epic.features.filter(f => f.title !== 'User Stories');
  });

  // User stories without feature - display as flat story rows only
  standaloneStoriesForTree = computed(() => {
    const epic = this.standaloneEpic();
    if (!epic) return [];
    const userStoriesFeature = epic.features.find(f => f.title === 'User Stories');
    if (!userStoriesFeature) return [];
    const query = this.searchQuery().toLowerCase();
    const status = this.statusFilter();
    const items: Array<{ story: UserStory; feature: Feature; epic: Epic }> = [];
    for (const story of userStoriesFeature.userStories) {
      const matchesSearch = !query ||
        story.title.toLowerCase().includes(query) ||
        story.description?.toLowerCase().includes(query);
      const effectiveStatus = this.getEffectiveStoryStatus(story);
      const matchesStatus = status === 'all' ||
        this.normalizeStatus(effectiveStatus) === status.toLowerCase();
      if (matchesSearch && matchesStatus) {
        items.push({ story, feature: userStoriesFeature, epic });
      }
    }
    return items;
  });

  /** Display epic title from string (for flat view) */
  getDisplayEpicTitle(epicTitle: string): string {
    return epicTitle === STANDALONE_EPIC_TITLE ? 'Standalone' : epicTitle;
  }

  // Flat list of all user stories with parent info
  flatStories = computed(() => {
    const query = this.searchQuery().toLowerCase();
    const status = this.statusFilter();
    const stories: Array<{
      story: UserStory;
      featureTitle: string;
      featureId: string;
      epicTitle: string;
      epicId: string;
    }> = [];

    for (const epic of this.epics()) {
      for (const feature of epic.features) {
        for (const story of feature.userStories) {
          // Apply filters
          const matchesSearch = !query || 
            story.title.toLowerCase().includes(query) ||
            story.description?.toLowerCase().includes(query) ||
            feature.title.toLowerCase().includes(query) ||
            epic.title.toLowerCase().includes(query);
          
          const effectiveStatus = this.getEffectiveStoryStatus(story);
          const matchesStatus = status === 'all' || 
            this.normalizeStatus(effectiveStatus) === status.toLowerCase();

          if (matchesSearch && matchesStatus) {
            stories.push({
              story,
              featureTitle: feature.title,
              featureId: feature.id,
              epicTitle: epic.title,
              epicId: epic.id
            });
          }
        }
      }
    }

    return stories;
  });

  constructor(
    private route: ActivatedRoute,
    private backlogService: BacklogService,
    private repositoryService: RepositoryService,
    private sandboxService: SandboxService,
    private sandboxBridgeService: SandboxBridgeService,
    private vncViewerService: VncViewerService,
    private aiConfigService: AIConfigService,
    private mcpConfigService: McpConfigService,
    private artifactFeedService: ArtifactFeedService,
    private authService: AuthService,
    private sanitizer: DomSanitizer,
    private markdownPipe: MarkdownPipe
  ) {
    // Sync with backlog service signal for real-time updates (e.g., when PR is created)
    effect(() => {
      const serviceBacklog = this.backlogService.backlog();
      if (serviceBacklog && serviceBacklog.length > 0) {
        console.log('[BacklogComponent] Syncing from service signal');
        this.epics.set([...serviceBacklog]); // Create new array to trigger change detection
      }
    }, { allowSignalWrites: true });
  }

  ngOnInit(): void {
    this.aiConfigService.loadLlmSettings();
    const repoId = this.route.snapshot.paramMap.get('repositoryId');
    if (repoId) {
      this.repositoryId.set(repoId);
      this.loadBacklog(repoId);
      this.loadRepository(repoId);
      this.refreshAzureIdentityWarningDismissedFromStorage(repoId);
      // Reconnect to existing backlog generation sandbox after page refresh (like code analysis)
      this.checkForExistingBacklogSandbox();
    } else {
      this.error.set('Repository ID is required');
    }

    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      const id = params.get('repositoryId');
      if (id) {
        this.refreshAzureIdentityWarningDismissedFromStorage(id);
      }
    });

    // Track which stories have open sandboxes
    this.vncViewerService.viewers$.pipe(
      takeUntil(this.destroy$)
    ).subscribe(viewers => {
      const storyIds = viewers
        .filter(v => v.implementationContext?.storyId)
        .map(v => v.implementationContext!.storyId);
      this.openSandboxStoryIds.set(storyIds);

      // If the backlog sandbox was actively generating and its viewer was just closed, stop immediately
      const inProgress = ['creating_sandbox', 'waiting_sandbox', 'sending', 'waiting_response', 'parsing', 'saving']
        .includes(this.generationState());
      if (inProgress) {
        const repoId = this.repositoryId();
        const backlogStillOpen = viewers.some(
          v => v.implementationContext?.storyId === `backlog-${repoId}`
        );
        if (!backlogStillOpen) {
          this.generationError.set('Sandbox was closed. Generation stopped.');
          this.generationState.set('error');
        }
      }

      // When viewers are restored after refresh, try to reconnect to backlog sandbox
      this.checkForExistingBacklogSandbox();
    });

    this.initBacklogCrudMediaQuery();
  }

  private initBacklogCrudMediaQuery(): void {
    if (typeof matchMedia === 'undefined') return;
    const mql = matchMedia(BacklogComponent.BACKLOG_CRUD_FORMS_MEDIA);
    this.backlogCrudMql = mql;
    this.applyBacklogCrudFormsAllowedFromMedia();
    mql.addEventListener('change', this.onBacklogCrudMediaChange);
  }

  private applyBacklogCrudFormsAllowedFromMedia(): void {
    const mql = this.backlogCrudMql;
    if (!mql) return;
    const allowed = !mql.matches;
    this.backlogCrudFormsAllowed.set(allowed);
    if (!allowed) {
      this.closeAddModal();
    }
  }

  /**
   * Check for an existing backlog generation sandbox (e.g. after page refresh).
   * If found, reconnect and resume polling for the backlog response.
   */
  private checkForExistingBacklogSandbox(): void {
    if (this.generationState() !== 'idle' && this.generationState() !== 'error') return;
    const currentRepoId = this.repositoryId();
    if (!currentRepoId) return;

    const viewers = this.vncViewerService.getViewers();
    const backlogViewer = viewers.find(
      v => v.implementationContext?.storyId === `backlog-${currentRepoId}` && v.implementationContext?.repositoryId === currentRepoId
    );

    if (backlogViewer?.bridgeUrl) {
      console.log('Found existing backlog sandbox for this repo, reconnecting...', backlogViewer.id);
      this.generationError.set(null);
      this.generationState.set('waiting_response');
      this.startPollingForResponse(backlogViewer.id);
    }
  }

  loadBacklog(repositoryId: string): void {
    this.loading.set(true);
    this.error.set(null);

    this.backlogService.getBacklog(repositoryId).subscribe({
      next: (epics) => {
        this.epics.set(epics);
        this.initSyncSelection();
        // Auto-expand first epic and standalone features (so content is visible)
        if (epics.length > 0) {
          const updates: Record<string, boolean> = { [epics[0].id]: true };
          const standalone = epics.find(e => e.title === STANDALONE_EPIC_TITLE);
          if (standalone) {
            for (const f of standalone.features) updates[f.id] = true;
          }
          this.expandedItems.update(state => ({ ...state, ...updates }));
        }
        this.loading.set(false);

        // Auto-sync PR statuses if we have stories with PRs
        this.syncPrStatuses(repositoryId, epics);
      },
      error: (err) => {
        this.error.set(err.message || 'Failed to load backlog');
        this.loading.set(false);
      }
    });
  }

  /**
   * Sync PR statuses from GitHub for stories that have PRs
   * Updates status to "Done" if PR is merged
   */
  private syncPrStatuses(repositoryId: string, epics: Epic[]): void {
    // Check if any story has a PR URL
    const hasStoriesWithPr = epics.some(epic => 
      epic.features.some(feature => 
        feature.userStories.some(story => story.prUrl)
      )
    );

    if (!hasStoriesWithPr) {
      return;
    }

    console.log('Syncing PR statuses from GitHub...');
    this.backlogService.syncPrStatuses(repositoryId).subscribe({
      next: (response) => {
        if (response.updatedCount > 0) {
          console.log(`Updated ${response.updatedCount} story statuses from GitHub PR status`);
          response.updatedStories.forEach(s => {
            console.log(`  - ${s.storyTitle}: ${s.oldStatus} -> ${s.newStatus} (PR merged: ${s.prMerged})`);
          });

          // Update local epics signal with new statuses from sync response
          const updatedStatusMap = new Map(
            response.updatedStories.map(s => [s.storyId, s.newStatus])
          );
          this.epics.update(currentEpics => currentEpics.map(epic => ({
            ...epic,
            features: epic.features.map(feature => ({
              ...feature,
              userStories: feature.userStories.map(story => {
                const newStatus = updatedStatusMap.get(story.id);
                return newStatus ? { ...story, status: newStatus } : story;
              })
            }))
          })));
        }
      },
      error: (err) => {
        console.warn('Failed to sync PR statuses:', err);
      }
    });
  }

  loadRepository(repositoryId: string): void {
    this.repositoryService.getRepositories().subscribe({
      next: (repos) => {
        const repo = repos.find(r => String(r.id) === String(repositoryId));
        if (repo) {
          this.repository.set(repo);
          this.repositoryName.set(repo.name);
        } else {
          const fromCache = this.repositoryService.getRepositoryById(repositoryId);
          if (fromCache) {
            this.repository.set(fromCache);
            this.repositoryName.set(fromCache.name);
          }
        }
      }
    });
  }

  getLlmSettings() {
    return this.aiConfigService.llmSettings();
  }

  currentLlmLabel(): string {
    const repo = this.repository();
    const settingId = repo?.llmSettingId;
    if (!settingId) return 'Default';
    const llm = this.aiConfigService.llmSettings().find(s => s.id === settingId);
    return llm?.name || llm?.model || 'Default';
  }

  toggleLlmDropdown(): void {
    this.showLlmDropdown.update(v => !v);
  }

  selectLlmOption(llmSettingId: string | null): void {
    this.showLlmDropdown.set(false);
    this.onRepoLlmChange(llmSettingId);
  }

  onRepoLlmChange(llmSettingId: string | null): void {
    const repo = this.repository();
    if (!repo) return;
    this.repoLlmUpdating.set(true);
    this.repositoryService.updateRepositoryLlmSetting(repo.id, llmSettingId).subscribe({
      next: (updated) => {
        // Merge updated fields into existing repo to preserve all properties
        this.repository.set({ ...repo, ...updated });
      },
      error: () => {
        this.repoLlmUpdating.set(false);
      },
      complete: () => {
        this.repoLlmUpdating.set(false);
      }
    });
  }

  // Expand/Collapse
  toggleExpand(itemId: string): void {
    this.expandedItems.update(state => ({
      ...state,
      [itemId]: !state[itemId]
    }));
  }

  isExpanded(itemId: string): boolean {
    return this.expandedItems()[itemId] ?? false;
  }

  expandAll(): void {
    const newState: ExpandedState = {};
    this.epics().forEach(epic => {
      newState[epic.id] = true;
      epic.features.forEach(feature => {
        newState[feature.id] = true;
      });
    });
    this.expandedItems.set(newState);
  }

  collapseAll(): void {
    this.expandedItems.set({});
  }

  // Add item modal
  openAddEpic(): void {
    this.addModalType.set('epic');
    this.addModalParentId.set(null);
  }

  openAddFeature(epicId?: string): void {
    this.addModalType.set('feature');
    this.addModalParentId.set(epicId ?? null);
  }

  openAddStory(featureId?: string): void {
    this.addModalType.set('story');
    this.addModalParentId.set(featureId ?? null);
  }

  closeAddModal(): void {
    this.addModalType.set(null);
    this.addModalParentId.set(null);
    this.editModalData.set(null);
  }

  // Edit item methods
  openEditEpic(epic: Epic): void {
    if (!this.backlogCrudFormsAllowed()) return;
    this.addModalType.set('epic');
    this.addModalParentId.set(null);
    this.editModalData.set({
      id: epic.id,
      title: epic.title,
      description: epic.description,
      status: epic.status
    });
  }

  openEditFeature(feature: Feature): void {
    if (!this.backlogCrudFormsAllowed()) return;
    this.addModalType.set('feature');
    this.addModalParentId.set(feature.epicId);
    this.editModalData.set({
      id: feature.id,
      title: feature.title,
      description: feature.description,
      status: feature.status
    });
  }

  openEditStory(story: UserStory): void {
    if (!this.backlogCrudFormsAllowed()) return;
    this.addModalType.set('story');
    this.addModalParentId.set(story.featureId);
    this.editModalData.set({
      id: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
      storyPoints: story.storyPoints,
      status: story.status
    });
  }

  // Open delete confirmation modal
  onDeleteEpic(epicId: string, event: Event): void {
    event.stopPropagation();
    const epic = this.epics().find(e => e.id === epicId);
    this.deleteConfirmation.set({ type: 'epic', id: epicId, title: epic?.title || 'Epic' });
  }

  onDeleteFeature(featureId: string, epicId: string, event: Event): void {
    event.stopPropagation();
    const epic = this.epics().find(e => e.id === epicId);
    const feature = epic?.features.find(f => f.id === featureId);
    this.deleteConfirmation.set({ type: 'feature', id: featureId, parentId: epicId, title: feature?.title || 'Feature' });
  }

  onDeleteStory(storyId: string, featureId: string, event: Event): void {
    event.stopPropagation();
    let storyTitle = 'User Story';
    for (const epic of this.epics()) {
      const feature = epic.features.find(f => f.id === featureId);
      if (feature) {
        const story = feature.userStories.find(s => s.id === storyId);
        if (story) storyTitle = story.title;
        break;
      }
    }
    this.deleteConfirmation.set({ type: 'story', id: storyId, parentId: featureId, title: storyTitle });
  }

  cancelDelete(): void {
    this.deleteConfirmation.set(null);
  }

  openBulkDeleteConfirmation(): void {
    const epicIds = Array.from(this.selectedSyncToAzureEpics());
    const featureIds = Array.from(this.selectedSyncToAzureFeatures());
    const storyIds = Array.from(this.selectedSyncToAzureStories());
    if (epicIds.length === 0 && featureIds.length === 0 && storyIds.length === 0) return;
    this.bulkDeleteConfirmation.set({ epicIds, featureIds, storyIds });
  }

  cancelBulkDelete(): void {
    this.bulkDeleteConfirmation.set(null);
  }

  confirmBulkDelete(): void {
    const confirmation = this.bulkDeleteConfirmation();
    if (!confirmation) return;
    const repoId = this.repositoryId();
    if (!repoId) return;
    this.bulkDeleteLoading.set(true);
    const { epicIds, featureIds, storyIds } = confirmation;
    const deletes = [
      ...storyIds.map(id => this.backlogService.deleteUserStory(id, repoId)),
      ...featureIds.map(id => this.backlogService.deleteFeature(id, repoId)),
      ...epicIds.map(id => this.backlogService.deleteEpic(id, repoId))
    ];
    if (deletes.length === 0) {
      this.bulkDeleteLoading.set(false);
      this.bulkDeleteConfirmation.set(null);
      return;
    }
    forkJoin(deletes).subscribe({
      next: () => {
        this.bulkDeleteLoading.set(false);
        this.bulkDeleteConfirmation.set(null);
        this.deselectAllForSyncToAzure();
        this.backlogService.getBacklog(repoId).subscribe(epics => this.epics.set(epics));
      },
      error: (err) => {
        this.bulkDeleteLoading.set(false);
        this.bulkDeleteConfirmation.set(null);
        this.error.set(err?.message || 'Failed to delete items');
      }
    });
  }

  confirmDelete(): void {
    const confirmation = this.deleteConfirmation();
    if (!confirmation) return;
    const repoId = this.repositoryId();
    if (!repoId) return;

    if (confirmation.type === 'epic') {
      this.backlogService.deleteEpic(confirmation.id, repoId).subscribe({
        next: () => {
          this.epics.update(epics => epics.filter(e => e.id !== confirmation.id));
          this.backlogService.getBacklog(repoId).subscribe(epics => this.epics.set(epics));
          this.deleteConfirmation.set(null);
        },
        error: (err) => {
          this.error.set(err.message || 'Failed to delete epic');
          this.deleteConfirmation.set(null);
        }
      });
    } else if (confirmation.type === 'feature' && confirmation.parentId) {
      this.backlogService.deleteFeature(confirmation.id, repoId).subscribe({
        next: () => {
          this.epics.update(epics =>
            epics.map(e => e.id === confirmation.parentId
              ? { ...e, features: e.features.filter(f => f.id !== confirmation.id) }
              : e
            )
          );
          this.backlogService.getBacklog(repoId).subscribe(epics => this.epics.set(epics));
          this.deleteConfirmation.set(null);
        },
        error: (err) => {
          this.error.set(err.message || 'Failed to delete feature');
          this.deleteConfirmation.set(null);
        }
      });
    } else if (confirmation.type === 'story' && confirmation.parentId) {
      this.backlogService.deleteUserStory(confirmation.id, repoId).subscribe({
        next: () => {
          this.epics.update(epics =>
            epics.map(epic => ({
              ...epic,
              features: epic.features.map(f =>
                f.id === confirmation.parentId
                  ? { ...f, userStories: f.userStories.filter(s => s.id !== confirmation.id) }
                  : f
              )
            }))
          );
          this.backlogService.getBacklog(repoId).subscribe(epics => this.epics.set(epics));
          this.deleteConfirmation.set(null);
        },
        error: (err) => {
          this.error.set(err.message || 'Failed to delete story');
          this.deleteConfirmation.set(null);
        }
      });
    }
  }

  onAddItem(data: {
    id?: string;
    title: string;
    description?: string;
    acceptanceCriteria?: string;
    storyPoints?: number;
    parentId?: string;
    status?: string;
  }): void {
    const type = this.addModalType();
    const parentId = data.parentId ?? this.addModalParentId();
    const repoId = this.repositoryId();
    const isEditing = !!data.id;

    if (!type || !repoId) {
      this.closeAddModal();
      return;
    }

    if (type === 'epic') {
      if (isEditing && data.id) {
        this.backlogService.updateEpic(data.id, data.title, data.description, data.status, repoId).subscribe({
          next: () => {
            this.backlogService.getBacklog(repoId).subscribe(epics => this.epics.set(epics));
            this.closeAddModal();
          },
          error: (err) => {
            this.error.set(err.message || 'Failed to update epic');
            this.closeAddModal();
          }
        });
      } else {
        this.backlogService.addEpic(repoId, data.title, data.description).subscribe({
          next: (newEpic) => {
            this.epics.update(epics => [...epics, { ...newEpic, features: newEpic.features ?? [] }]);
            this.backlogService.getBacklog(repoId).subscribe(epics => this.epics.set(epics));
            this.closeAddModal();
          },
          error: (err) => {
            this.error.set(err.message || 'Failed to add epic');
            this.closeAddModal();
          }
        });
      }
    } else if (type === 'feature') {
      if (isEditing && data.id) {
        this.backlogService.updateFeature(data.id, data.title, data.description, data.status, repoId).subscribe({
          next: () => {
            this.backlogService.getBacklog(repoId).subscribe(epics => this.epics.set(epics));
            this.closeAddModal();
          },
          error: (err) => {
            this.error.set(err.message || 'Failed to update feature');
            this.closeAddModal();
          }
        });
      } else if (parentId) {
        this.backlogService.addFeature(parentId, data.title, data.description, repoId).subscribe({
          next: (newFeature) => {
            this.epics.update(epics =>
              epics.map(e => e.id === parentId
                ? { ...e, features: [...(e.features || []), { ...newFeature, userStories: newFeature.userStories ?? [] }] }
                : e
              )
            );
            this.backlogService.getBacklog(repoId).subscribe(epics => this.epics.set(epics));
            this.closeAddModal();
          },
          error: (err) => {
            this.error.set(err.message || 'Failed to add feature');
            this.closeAddModal();
          }
        });
      }
    } else if (type === 'story') {
      if (isEditing && data.id) {
        this.backlogService.updateUserStory(
          data.id,
          data.title,
          data.description,
          data.acceptanceCriteria,
          data.storyPoints,
          data.status,
          repoId
        ).subscribe({
          next: () => {
            this.backlogService.getBacklog(repoId).subscribe(epics => this.epics.set(epics));
            this.closeAddModal();
          },
          error: (err) => {
            this.error.set(err.message || 'Failed to update user story');
            this.closeAddModal();
          }
        });
      } else if (parentId) {
        this.backlogService.addUserStory(
          parentId,
          data.title,
          data.description,
          data.acceptanceCriteria,
          data.storyPoints,
          repoId
        ).subscribe({
          next: (newStory) => {
            this.epics.update(epics =>
              epics.map(epic => ({
                ...epic,
                features: epic.features.map(f =>
                  f.id === parentId
                    ? { ...f, userStories: [...(f.userStories || []), { ...newStory, tasks: newStory.tasks ?? [] }] }
                    : f
                )
              }))
            );
            this.backlogService.getBacklog(repoId).subscribe(epics => this.epics.set(epics));
            this.closeAddModal();
          },
          error: (err) => {
            this.error.set(err.message || 'Failed to add user story');
            this.closeAddModal();
          }
        });
      }
    }
  }

  // Selection - toggle inline details (for epics and features only)
  selectItem(itemId: string): void {
    // Toggle selection if clicking the same item
    if (this.selectedItemId() === itemId) {
      this.selectedItemId.set(null); // Deselect to close details
    } else {
      this.selectedItemId.set(itemId);
    }
  }

  isSelected(itemId: string): boolean {
    return this.selectedItemId() === itemId;
  }

  // Click on user story row - toggle details (same as epics/features)
  onUserStoryClick(storyId: string): void {
    this.selectItem(storyId);
  }

  // Click on implement button - open sandbox
  onImplementClick(event: Event, story: UserStory, featureTitle: string, epicTitle: string): void {
    event.stopPropagation(); // Don't trigger row click
    this.implementUserStory(story, featureTitle, epicTitle);
  }

  /**
   * Open a sandbox with the user story implementation prompt
   */
  implementUserStory(story: UserStory, featureTitle: string, epicTitle: string): void {
    const repo = this.repository();
    if (!repo) {
      this.error.set('Repository not found');
      return;
    }

    this.creatingSandboxForStory.set(story.id);
    this.error.set(null);

    // Use effective AI config for this repository (default or repo override)
    this.aiConfigService.getEffectiveConfig(repo.id).then((aiConfig) => {
      if (!aiConfig.apiKey) {
        this.creatingSandboxForStory.set(null);
        this.error.set('AI is not configured. Please configure AI settings first.');
        return;
      }
      const defaultBranch = repo.defaultBranch || 'main';

      Promise.all([
        this.mcpConfigService.getEnabledServers(),
        this.artifactFeedService.getEnabledFeeds(),
      ]).then(([mcpServers, artifactFeeds]) => {
      const zedSettings = this.aiConfigService.getZedSettingsJson(aiConfig, mcpServers);
      const feedsPayload = artifactFeeds.map(f => ({
        name: f.name, organization: f.organization, feedName: f.feedName,
        projectName: f.projectName, feedType: f.feedType,
      }));

      const openSandboxWithBranch = (repoUrl: string, branch: string, archiveUrl?: string) => {
        this.createImplementationSandbox(repo, repoUrl, story, featureTitle, epicTitle, aiConfig, zedSettings, branch, archiveUrl, feedsPayload);
      };

      const resolveBranch = (repoUrl: string, archiveUrl?: string) => {
        // Stories with an existing PR (e.g. PendingReview): clone the PR's source branch, not default
        if (story.prUrl?.trim()) {
          this.backlogService.getPrHeadBranch(story.prUrl.trim()).subscribe({
            next: (res) => {
              openSandboxWithBranch(repoUrl, res.branch, archiveUrl);
            },
            error: (err) => {
              console.warn('[Sandbox] Failed to get PR branch, using default:', err);
              openSandboxWithBranch(repoUrl, defaultBranch, archiveUrl);
            }
          });
          return;
        }
        openSandboxWithBranch(repoUrl, defaultBranch, archiveUrl);
      };

      this.repositoryService.getAuthenticatedCloneUrl(repo.id).subscribe({
        next: (result) => resolveBranch(result.cloneUrl, result.archiveUrl),
        error: (err) => {
          console.error('Failed to get authenticated clone URL:', err);
          const repoUrl = this.buildRepoCloneUrl(repo);
          resolveBranch(repoUrl);
        }
      });
      });
    }).catch((err) => {
      console.error('Failed to get AI config:', err);
      this.creatingSandboxForStory.set(null);
      this.error.set('AI is not configured. Please configure AI settings first.');
    });
  }

  private createImplementationSandbox(
    repo: Repository,
    repoUrl: string,
    story: UserStory,
    featureTitle: string,
    epicTitle: string,
    aiConfig: any,
    zedSettings: object,
    branch: string,
    repoArchiveUrl?: string,
    artifactFeeds?: any[]
  ): void {
    this.sandboxService.createSandbox({
      repo_url: repoUrl,
      repo_name: repo.name,
      repo_branch: branch,
      repo_archive_url: repoArchiveUrl,
      ai_config: {
        provider: aiConfig.provider,
        api_key: aiConfig.apiKey,
        model: aiConfig.model,
        base_url: aiConfig.baseUrl
      },
      zed_settings: zedSettings,
      artifact_feeds: artifactFeeds?.length ? artifactFeeds : undefined,
      agent_rules: repo.agentRules || DEFAULT_AGENT_RULES,
    }).subscribe({
      next: (sandbox) => {
        console.log('Sandbox created for user story:', story.title);
        
        // First-time implementation only: move to InProgress. If a PR exists (e.g. PendingReview), keep that status.
        if (!story.prUrl) {
          this.backlogService.updateStoryStatus(story.id, 'InProgress').subscribe({
            next: () => console.log('Story status updated to InProgress'),
            error: (err) => console.warn('Failed to update story status to InProgress:', err)
          });
        }
        
        setTimeout(() => {
          this.creatingSandboxForStory.set(null);
          
          // Open VNC viewer with implementation context for Push & Create PR
          const vncUrl = sandbox.url ? `${sandbox.url}${sandbox.url.includes("?") ? "&" : "?"}autoconnect=true&resize=scale` : '';
          this.vncViewerService.open(
            {
              url: vncUrl,
              autoConnect: true,
              scalingMode: 'local',
              useIframe: true
            },
            sandbox.id,
            `${repo.name} - ${story.title}`,
            {
              repositoryId: repo.id,
              repositoryFullName: repo.fullName,
              defaultBranch: repo.defaultBranch || 'main',
              storyTitle: story.title,
              storyId: story.id,
              azureDevOpsWorkItemId: story.azureDevOpsWorkItemId
            },
            sandbox.sandbox_token,
            sandbox.bridge_url,
            sandbox.vnc_password
          );

          if (sandbox.bridge_url && !story.prUrl) {
            const sid = sandbox.id;
            const prompt = this.buildImplementationPrompt(story, featureTitle, epicTitle);
            const maxRetries = 5;

            const sendWithRetry = (attempt: number) => {
              const delay = attempt === 0 ? 25000 : 15000;
              setTimeout(() => {
                const promptSentTimestamp = Date.now() / 1000;
                console.log(`Sending implementation prompt to Zed (attempt ${attempt + 1}/${maxRetries})...`);

                this.sandboxBridgeService.sendZedPrompt(sid, prompt).subscribe({
                  next: (result) => {
                    console.log('Implementation prompt sent:', result);

                    this.sandboxBridgeService.waitForImplementationComplete(
                      sid,
                      promptSentTimestamp,
                      5000,
                      600000
                    ).subscribe({
                      next: (conversation) => {
                        console.log('Implementation completed!', conversation);
                        this.vncViewerService.setReadyForPrByStoryId(story.id, true);
                      },
                      error: (err) => {
                        console.warn('Failed to detect implementation completion:', err);
                      }
                    });
                  },
                  error: (err) => {
                    console.warn(`Prompt send attempt ${attempt + 1} failed:`, err);
                    if (attempt + 1 < maxRetries) {
                      sendWithRetry(attempt + 1);
                    } else {
                      console.error('All prompt send attempts failed after retries');
                    }
                  }
                });
              }, delay);
            };
            sendWithRetry(0);
          } else if (story.prUrl) {
            console.log('Story already has PR, skipping auto-prompt - user can interact manually');
          }
        }, VPS_CONFIG.sandboxReadyDelayMs);
      },
      error: (err) => {
        console.error('Failed to create sandbox:', err);
        this.creatingSandboxForStory.set(null);
        this.error.set('Failed to create sandbox: ' + (err.message || 'Unknown error'));
      }
    });
  }

  /**
   * Build the implementation prompt for a user story
   */
  private buildImplementationPrompt(story: UserStory, featureTitle: string, epicTitle: string): string {
    let prompt = `Please implement the following User Story:

## Epic: ${epicTitle}
## Feature: ${featureTitle}

## User Story: ${story.title}

**Description:**
${story.description || 'No description provided'}
`;

    if (story.acceptanceCriteria) {
      prompt += `
**Acceptance Criteria:**
${story.acceptanceCriteria}
`;
    }

    if (story.storyPoints) {
      prompt += `
**Story Points:** ${story.storyPoints}
`;
    }
    return prompt;
  }

  /**
   * Build repository clone URL
   */
  private buildRepoCloneUrl(repo: Repository): string {
    if (repo.cloneUrl) {
      return repo.cloneUrl;
    }
    // Fallback: construct from full name
    return `https://github.com/${repo.fullName}.git`;
  }

  isCreatingSandbox(storyId: string): boolean {
    return this.creatingSandboxForStory() === storyId;
  }

  hasOpenSandbox(storyId: string): boolean {
    return this.openSandboxStoryIds().includes(storyId);
  }

  /**
   * Effective status for a user story (avoids ghost InProgress after refresh/close):
   * - Done: keep stored Done (e.g. PR merged).
   * - Has PR (open): PendingReview.
   * - No PR, sandbox open: InProgress.
   * - No PR, no sandbox: Backlog.
   */
  getEffectiveStoryStatus(story: UserStory): string {
    const s = (story.status || '').toLowerCase().replace(/\s+/g, '');
    if (s === 'done' || s === 'completed' || s === 'closed') {
      return story.status;
    }
    if (story.prUrl) {
      return 'PendingReview';
    }
    if (this.hasOpenSandbox(story.id)) {
      return 'InProgress';
    }
    return 'Backlog';
  }

  focusSandbox(event: Event, storyId: string): void {
    event.stopPropagation();
    const viewer = this.vncViewerService.getViewerByStoryId(storyId);
    if (viewer) {
      this.vncViewerService.bringToFront(viewer.id);
    }
  }

  // Modal
  ngOnDestroy(): void {
    if (this.backlogCrudMql) {
      this.backlogCrudMql.removeEventListener('change', this.onBacklogCrudMediaChange);
      this.backlogCrudMql = undefined;
    }
    this.destroy$.next();
    this.destroy$.complete();
  }

  confirmStartGeneration(): void {
    this.showGeneratePromptModal.set(false);
    this.generateBacklog();
  }

  generateBacklog(): void {
    const repo = this.repository();
    if (!repo) {
      this.generationError.set('Repository not found');
      this.generationState.set('error');
      return;
    }

    // Use effective AI config for this repository (default or repo override)
    this.aiConfigService.getEffectiveConfig(repo.id).then((aiConfig) => {
      if (!aiConfig.apiKey) {
        this.generationError.set('AI is not configured. Please configure AI settings first.');
        this.generationState.set('error');
        return;
      }
      const viewers = this.vncViewerService.getViewers();
      // Match only the backlog sandbox for this exact repository (not implementation sandboxes for stories)
      const activeSandbox = viewers.find(v =>
        v.implementationContext?.repositoryId === repo.id &&
        v.implementationContext?.storyId?.startsWith('backlog-')
      ) || null;
      if (activeSandbox?.bridgeUrl) {
        this.sendBacklogPrompt(activeSandbox.id);
      } else {
        this.createSandboxAndGenerate();
      }
    }).catch((err) => {
      console.error('Failed to get AI config:', err);
      this.generationError.set('AI is not configured. Please configure AI settings first.');
      this.generationState.set('error');
    });
  }

  private createSandboxAndGenerate(): void {
    const repo = this.repository();
    if (!repo) return;

    this.generationState.set('creating_sandbox');
    this.generationError.set(null);

    this.aiConfigService.getEffectiveConfig(repo.id).then((aiConfig) => {
      Promise.all([
        this.mcpConfigService.getEnabledServers(),
        this.artifactFeedService.getEnabledFeeds(),
      ]).then(([mcpServers, artifactFeeds]) => {
        const zedSettings = this.aiConfigService.getZedSettingsJson(aiConfig, mcpServers);
        const feedsPayload = artifactFeeds.map(f => ({
          name: f.name, organization: f.organization, feedName: f.feedName,
          projectName: f.projectName, feedType: f.feedType,
        }));
        this.repositoryService.getAuthenticatedCloneUrl(repo.id).subscribe({
          next: (result) => {
            this.createSandboxWithConfig(repo, result.cloneUrl, aiConfig, zedSettings, result.archiveUrl, feedsPayload);
          },
          error: (err) => {
            console.error('Failed to get authenticated clone URL:', err);
            const repoUrl = this.buildRepoCloneUrl(repo);
            this.createSandboxWithConfig(repo, repoUrl, aiConfig, zedSettings, undefined, feedsPayload);
          }
        });
      });
    }).catch((err) => {
      console.error('Failed to get AI config:', err);
      this.generationError.set('AI is not configured. Please configure AI settings first.');
      this.generationState.set('error');
    });
  }

  private createSandboxWithConfig(
    repo: Repository, 
    repoUrl: string, 
    aiConfig: any, 
    zedSettings: object,
    repoArchiveUrl?: string,
    artifactFeeds?: any[]
  ): void {
    this.sandboxService.createSandbox({
      repo_url: repoUrl,
      repo_name: repo.name,
      repo_branch: repo.defaultBranch || 'main',
      repo_archive_url: repoArchiveUrl,
      ai_config: {
        provider: aiConfig.provider,
        api_key: aiConfig.apiKey,
        model: aiConfig.model,
        base_url: aiConfig.baseUrl
      },
      zed_settings: zedSettings,
      artifact_feeds: artifactFeeds?.length ? artifactFeeds : undefined,
    }).subscribe({
      next: (sandbox) => {
        if (!sandbox.bridge_url) {
          this.generationError.set('Sandbox created but bridge URL not available.');
          this.generationState.set('error');
          return;
        }

        this.createdSandboxId = sandbox.id;
        const vncUrl = sandbox.url ? `${sandbox.url}${sandbox.url.includes("?") ? "&" : "?"}autoconnect=true&resize=scale` : '';

        setTimeout(() => {
          this.vncViewerService.open(
            {
              url: vncUrl,
              autoConnect: true,
              scalingMode: 'local',
              useIframe: true
            },
            sandbox.id,
            `${repo.name} - Backlog`,
            {
              repositoryId: repo.id,
              repositoryFullName: repo.fullName || repo.name,
              defaultBranch: repo.defaultBranch || 'main',
              storyTitle: 'Backlog Generation',
              storyId: `backlog-${repo.id}`
            },
            sandbox.sandbox_token,
            sandbox.bridge_url,
            sandbox.vnc_password
          );

          this.generationState.set('waiting_sandbox');
          setTimeout(() => {
            this.sendBacklogPrompt(sandbox.id);
          }, 20000);
        }, VPS_CONFIG.sandboxReadyDelayMs);
      },
      error: (err) => {
        this.generationError.set('Failed to create sandbox: ' + (err.message || 'Unknown error'));
        this.generationState.set('error');
      }
    });
  }

  private waitForZedAndSendBacklogPrompt(sandboxId: string): void {
    this.generationState.set('sending');
    const prompt = this.buildBacklogPrompt();

    console.log('Waiting for Zed to be ready before sending backlog prompt...');
    this.sandboxBridgeService.waitForZedAndSendPrompt(sandboxId, prompt).subscribe({
      next: (result) => {
        console.log('Backlog prompt sent:', result);
        this.generationState.set('waiting_response');
        this.startPollingForResponse(sandboxId);
      },
      error: (err) => {
        console.warn('Failed to send backlog prompt:', err);
        this.generationError.set('Failed to send prompt to Zed. Please ensure the sandbox is running and Zed is ready.');
        this.generationState.set('error');
      }
    });
  }

  private sendBacklogPrompt(sandboxId: string): void {
    this.generationState.set('sending');
    const prompt = this.buildBacklogPrompt();

    this.sandboxBridgeService.sendZedPrompt(sandboxId, prompt).subscribe({
      next: () => {
        this.generationState.set('waiting_response');
        this.startPollingForResponse(sandboxId);
      },
      error: () => {
        setTimeout(() => {
          this.sandboxBridgeService.sendZedPrompt(sandboxId, prompt).subscribe({
            next: () => {
              this.generationState.set('waiting_response');
              this.startPollingForResponse(sandboxId);
            },
            error: () => {
              this.generationError.set('Failed to send prompt to Zed. Please ensure the sandbox is running and Zed is ready.');
              this.generationState.set('error');
            }
          });
        }, 5000);
      }
    });
  }

  private buildBacklogPrompt(): string {
    const jsonFormatRequirement = `

IMPORTANT: Return ONLY valid JSON in this exact format:
\`\`\`json
{
  "epics": [
    {
      "title": "Epic Title",
      "description": "Epic description",
      "features": [
        {
          "title": "Feature Title",
          "description": "Feature description",
          "userStories": [
            {
              "title": "User Story Title",
              "description": "As a user, I want to...",
              "acceptanceCriteria": ["Criteria 1", "Criteria 2"],
              "storyPoints": 3
            }
          ]
        }
      ]
    }
  ]
}
\`\`\``;

    if (this.promptMode() === 'custom') {
      const custom = this.customPrompt().trim();
      if (!custom) {
        // Fallback to general if custom is empty
        return this.buildGeneralPrompt(jsonFormatRequirement);
      }
      return custom + jsonFormatRequirement;
    }

    return this.buildGeneralPrompt(jsonFormatRequirement);
  }

  private buildGeneralPrompt(jsonFormatRequirement: string): string {
    let prompt = `Please analyze this repository and generate a product backlog in JSON format.

Create a structured backlog with:
- 3-5 Epics (major features or initiatives)
- 2-4 Features per Epic
- 2-3 User Stories per Feature

For each item, provide:
- A clear, concise title
- A detailed description
- For User Stories: acceptance criteria and story points (1, 2, 3, 5, or 8)
${jsonFormatRequirement}`;

    const additional = this.customInstructions().trim();
    if (additional) {
      prompt += `\n\nAdditional requirements:\n${additional}`;
    }

    return prompt;
  }

  private startPollingForResponse(sandboxId: string): void {
    let consecutiveErrors = 0;

    interval(3000).pipe(
      takeUntil(this.destroy$),
      filter(() => this.generationState() === 'waiting_response'),
      switchMap(() =>
        this.sandboxBridgeService.getLatestZedConversation(sandboxId).pipe(
          catchError(err => {
            consecutiveErrors++;
            if (consecutiveErrors >= 3) {
              this.generationError.set('Sandbox connection lost — the container may have been stopped.');
              this.generationState.set('error');
            }
            return EMPTY;
          })
        )
      )
    ).subscribe({
      next: (conv) => {
        consecutiveErrors = 0;
        if (conv && conv.id !== this.lastConversationId) {
          this.latestResponse.set(conv);

          if (this.containsBacklogJson(conv.assistant_message)) {
            this.lastConversationId = conv.id;
            this.parseAndSaveBacklog(conv.assistant_message);
          }
        }
      }
    });
  }

  private containsBacklogJson(response: string): boolean {
    return response.includes('"epics"');
  }

  private parseAndSaveBacklog(response: string): void {
    const repoId = this.repositoryId();
    if (!repoId) {
      this.generationError.set('Repository ID not found');
      this.generationState.set('error');
      return;
    }

    // If we already have backlog items (e.g. reconnected after refresh and response was already saved),
    // do not parse/save again to avoid duplicates.
    if (this.epics().length > 0) {
      this.generationState.set('complete');
      this.loadBacklog(repoId);
      setTimeout(() => {
        this.generationState.set('idle');
        this.latestResponse.set(null);
        this.lastConversationId = null;
      }, 2000);
      return;
    }

    this.generationState.set('parsing');

    try {
      // Extract JSON from markdown code block if present
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      } else {
        // Fallback: extract raw JSON object
        const jsonStart = response.indexOf('{');
        const jsonEnd = response.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
          jsonStr = response.substring(jsonStart, jsonEnd + 1);
        }
      }

      const backlog = JSON.parse(jsonStr);

      if (!backlog.epics || !Array.isArray(backlog.epics)) {
        throw new Error('Invalid backlog format: missing epics array');
      }

      this.generationState.set('saving');

      this.backlogService.createBacklog(repoId, backlog).subscribe({
        next: () => {
          this.generationState.set('complete');
          this.loadBacklog(repoId);
          setTimeout(() => {
            this.generationState.set('idle');
            this.latestResponse.set(null);
            this.lastConversationId = null;
          }, 2000);
        },
        error: (err) => {
          this.generationError.set('Failed to save backlog: ' + (err.error?.message || err.message));
          this.generationState.set('error');
        }
      });
    } catch (error: any) {
      this.generationError.set('Failed to parse backlog JSON: ' + (error.message || 'Invalid JSON format'));
      this.generationState.set('error');
    }
  }

  // Progress calculation - uses weighted average based on story statuses
  // Backlog=0%, InProgress=25%, PendingReview=50%, Done=100%
  getEpicProgress(epic: Epic): number {
    const stories = epic.features.flatMap(f => f.userStories);
    if (stories.length === 0) return 0;
    const totalProgress = stories.reduce((sum, story) => 
      sum + this.getStatusPercentage(this.getEffectiveStoryStatus(story)), 0
    );
    return Math.round(totalProgress / stories.length);
  }

  getFeatureProgress(feature: Feature): number {
    if (feature.userStories.length === 0) return 0;
    const totalProgress = feature.userStories.reduce((sum, story) => 
      sum + this.getStatusPercentage(this.getEffectiveStoryStatus(story)), 0
    );
    return Math.round(totalProgress / feature.userStories.length);
  }

  getStoryProgress(story: UserStory): number {
    return this.getStatusPercentage(this.getEffectiveStoryStatus(story));
  }

  getEpicStoryPoints(epic: Epic): number {
    return epic.features.reduce((sum, f) => 
      sum + f.userStories.reduce((sSum, s) => sSum + (s.storyPoints || 0), 0), 0
    );
  }

  getFeatureStoryPoints(feature: Feature): number {
    return feature.userStories.reduce((sum, s) => sum + (s.storyPoints || 0), 0);
  }

  // Status helpers
  // Backlog (0%) -> InProgress (25%) -> PendingReview (50%, PR open) -> Done (100%, PR merged)
  getStatusClass(status: string): string {
    const s = status.toLowerCase();
    if (s === 'done' || s === 'completed' || s === 'closed') return 'status-done';
    if (s === 'pendingreview' || s === 'pending review' || s === 'review') return 'status-pendingreview';
    if (s === 'inprogress' || s === 'in progress' || s === 'active') return 'status-inprogress';
    if (s === 'blocked') return 'status-blocked';
    return 'status-new';
  }

  /** Short readable label for status pills (not raw ADO strings). */
  getStatusLabel(status: string): string {
    const norm = this.normalizeStatus(status);
    if (norm === 'done') return 'Done';
    if (norm === 'pendingreview') return 'Review';
    if (norm === 'inprogress') return 'In progress';
    if (norm === 'blocked') return 'Blocked';
    const raw = (status || '').trim();
    if (!raw) return 'Backlog';
    const expanded = raw.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    const words = expanded.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return 'Backlog';
    return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  getStatusPercentage(status: string): number {
    const s = status.toLowerCase();
    if (s === 'done' || s === 'completed' || s === 'closed') return 100;
    if (s === 'pendingreview' || s === 'pending review' || s === 'review') return 50;
    if (s === 'inprogress' || s === 'in progress' || s === 'active') return 25;
    return 0;
  }

  // Normalize status for filtering (handles different formats)
  normalizeStatus(status: string): string {
    const s = status.toLowerCase().replace(/\s+/g, '');
    if (s === 'done' || s === 'completed' || s === 'closed') return 'done';
    if (s === 'pendingreview' || s === 'pendingmerge' || s === 'review') return 'pendingreview';
    if (s === 'inprogress' || s === 'active' || s === 'started') return 'inprogress';
    if (s === 'blocked') return 'blocked';
    if (s === 'backlog' || s === 'new' || s === 'todo') return 'new';
    return 'new';
  }

  // Work item type icons
  getWorkItemIcon(type: WorkItemType): string {
    switch (type) {
      case 'epic': return 'E';
      case 'feature': return 'F';
      case 'story': return 'S';
    }
  }

  getWorkItemColor(type: WorkItemType): string {
    switch (type) {
      case 'epic': return '#f59e0b'; // Amber
      case 'feature': return '#8b5cf6'; // Purple
      case 'story': return '#3b82f6'; // Blue
    }
  }

  /** Whether a flat story item is standalone (no epic/feature parent) */
  isStandaloneStory(item: { epicTitle: string }): boolean {
    return item.epicTitle === STANDALONE_EPIC_TITLE;
  }

  /** Whether a user story has a warning (missing acceptance criteria or story points) */
  hasStoryWarning(story: UserStory): boolean {
    const hasAc = story.acceptanceCriteria != null && String(story.acceptanceCriteria).trim().length > 0;
    const hasPoints = story.storyPoints != null && story.storyPoints > 0;
    return !hasAc || !hasPoints;
  }

  /** Warning message for story missing acceptance criteria or story points */
  getStoryWarningMessage(story: UserStory): string {
    const missing: string[] = [];
    const hasAc = story.acceptanceCriteria != null && String(story.acceptanceCriteria).trim().length > 0;
    const hasPoints = story.storyPoints != null && story.storyPoints > 0;
    if (!hasAc) missing.push('acceptance criteria');
    if (!hasPoints) missing.push('story points');
    return missing.length > 0 ? `Missing: ${missing.join(', ')}` : '';
  }

  /** Azure DevOps story missing acceptance criteria or story points */
  hasAzureDevOpsStoryWarning(story: AzureDevOpsWorkItem): boolean {
    const hasAc = story.acceptanceCriteria != null && String(story.acceptanceCriteria).trim().length > 0;
    const hasPoints = story.storyPoints != null && story.storyPoints > 0;
    return !hasAc || !hasPoints;
  }

  getAzureDevOpsStoryWarningMessage(story: AzureDevOpsWorkItem): string {
    const missing: string[] = [];
    const hasAc = story.acceptanceCriteria != null && String(story.acceptanceCriteria).trim().length > 0;
    const hasPoints = story.storyPoints != null && story.storyPoints > 0;
    if (!hasAc) missing.push('acceptance criteria');
    if (!hasPoints) missing.push('story points');
    return missing.length > 0 ? `Missing: ${missing.join(', ')}` : '';
  }

  // Azure DevOps Import Methods
  initSyncSelection(): void {
    this.selectedSyncToAzureEpics.set(new Set());
    this.selectedSyncToAzureFeatures.set(new Set());
    this.selectedSyncToAzureStories.set(new Set());
  }

  selectAllForSyncToAzure(): void {
    const epics = this.epics();
    const epicIds = new Set<string>();
    const featureIds = new Set<string>();
    const storyIds = new Set<string>();
    for (const epic of epics) {
      epicIds.add(epic.id);
      for (const feature of epic.features || []) {
        featureIds.add(feature.id);
        for (const story of feature.userStories || []) {
          storyIds.add(story.id);
        }
      }
    }
    this.selectedSyncToAzureEpics.set(epicIds);
    this.selectedSyncToAzureFeatures.set(featureIds);
    this.selectedSyncToAzureStories.set(storyIds);
  }

  deselectAllForSyncToAzure(): void {
    this.selectedSyncToAzureEpics.set(new Set());
    this.selectedSyncToAzureFeatures.set(new Set());
    this.selectedSyncToAzureStories.set(new Set());
  }

  toggleEpicForSync(epicId: string, event: Event): void {
    event.stopPropagation();
    const epic = this.epics().find(e => e.id === epicId);
    if (!epic) return;
    const featureIds = (epic.features || []).map(f => f.id);
    const storyIds = (epic.features || []).flatMap(f => (f.userStories || []).map(s => s.id));
    const epicSelected = this.selectedSyncToAzureEpics().has(epicId);
    const selectedEpics = new Set(this.selectedSyncToAzureEpics());
    const selectedFeatures = new Set(this.selectedSyncToAzureFeatures());
    const selectedStories = new Set(this.selectedSyncToAzureStories());
    if (epicSelected) {
      selectedEpics.delete(epicId);
      featureIds.forEach(id => selectedFeatures.delete(id));
      storyIds.forEach(id => selectedStories.delete(id));
    } else {
      selectedEpics.add(epicId);
      featureIds.forEach(id => selectedFeatures.add(id));
      storyIds.forEach(id => selectedStories.add(id));
    }
    this.selectedSyncToAzureEpics.set(selectedEpics);
    this.selectedSyncToAzureFeatures.set(selectedFeatures);
    this.selectedSyncToAzureStories.set(selectedStories);
  }

  toggleFeatureForSync(featureId: string, event: Event): void {
    event.stopPropagation();
    let feature: Feature | undefined;
    for (const epic of this.epics()) {
      feature = epic.features?.find(f => f.id === featureId);
      if (feature) break;
    }
    if (!feature) return;
    const storyIds = (feature.userStories || []).map(s => s.id);
    const featureSelected = this.selectedSyncToAzureFeatures().has(featureId);
    const selectedFeatures = new Set(this.selectedSyncToAzureFeatures());
    const selectedStories = new Set(this.selectedSyncToAzureStories());
    if (featureSelected) {
      selectedFeatures.delete(featureId);
      storyIds.forEach(id => selectedStories.delete(id));
    } else {
      selectedFeatures.add(featureId);
      storyIds.forEach(id => selectedStories.add(id));
    }
    this.selectedSyncToAzureFeatures.set(selectedFeatures);
    this.selectedSyncToAzureStories.set(selectedStories);
  }

  toggleStoryForSync(storyId: string, event: Event): void {
    event.stopPropagation();
    const set = new Set(this.selectedSyncToAzureStories());
    if (set.has(storyId)) set.delete(storyId);
    else set.add(storyId);
    this.selectedSyncToAzureStories.set(set);
  }

  /** Epic checkbox state: checked (all selected), indeterminate (some selected), unchecked */
  getEpicCheckboxState(epicId: string): 'checked' | 'indeterminate' | 'unchecked' {
    const epic = this.epics().find(e => e.id === epicId);
    if (!epic) return 'unchecked';
    const features = epic.features || [];
    const storyIds = features.flatMap(f => (f.userStories || []).map(s => s.id));
    const featureIds = features.map(f => f.id);
    const epicSelected = this.selectedSyncToAzureEpics().has(epicId);
    const selectedFeatureCount = featureIds.filter(id => this.selectedSyncToAzureFeatures().has(id)).length;
    const selectedStoryCount = storyIds.filter(id => this.selectedSyncToAzureStories().has(id)).length;
    const allSelected = epicSelected && selectedFeatureCount === featureIds.length && selectedStoryCount === storyIds.length;
    const someSelected = epicSelected || selectedFeatureCount > 0 || selectedStoryCount > 0;
    if (allSelected) return 'checked';
    if (someSelected) return 'indeterminate';
    return 'unchecked';
  }

  /** Feature checkbox state: checked (all selected), indeterminate (some selected), unchecked */
  getFeatureCheckboxState(featureId: string): 'checked' | 'indeterminate' | 'unchecked' {
    let feature: Feature | undefined;
    for (const epic of this.epics()) {
      feature = epic.features?.find(f => f.id === featureId);
      if (feature) break;
    }
    if (!feature) return 'unchecked';
    const storyIds = (feature.userStories || []).map(s => s.id);
    const featureSelected = this.selectedSyncToAzureFeatures().has(featureId);
    const selectedStoryCount = storyIds.filter(id => this.selectedSyncToAzureStories().has(id)).length;
    const allSelected = featureSelected && selectedStoryCount === storyIds.length;
    const someSelected = featureSelected || selectedStoryCount > 0;
    if (allSelected) return 'checked';
    if (someSelected) return 'indeterminate';
    return 'unchecked';
  }

  isEpicSelectedForSync(epicId: string): boolean {
    return this.selectedSyncToAzureEpics().has(epicId);
  }

  isFeatureSelectedForSync(featureId: string): boolean {
    return this.selectedSyncToAzureFeatures().has(featureId);
  }

  isStorySelectedForSync(storyId: string): boolean {
    return this.selectedSyncToAzureStories().has(storyId);
  }

  /** Build GitHub issue URL when repo is GitHub and story has issue number */
  getGitHubIssueUrl(story: UserStory): string | null {
    const repo = this.repository() ?? this.repositoryService.getRepositoryById(this.repositoryId()) ?? null;
    if (!repo?.fullName) return null;
    const provider = (repo.provider ?? '').toLowerCase();
    if (provider !== 'github') return null;
    const issueNumber = story?.gitHubIssueNumber;
    if (issueNumber == null) return null;
    return `https://github.com/${repo.fullName}/issues/${issueNumber}`;
  }

  /** Build GitHub issue URL for a feature when repo is GitHub and feature has issue number */
  getGitHubFeatureIssueUrl(feature: Feature): string | null {
    const repo = this.repository() ?? this.repositoryService.getRepositoryById(this.repositoryId()) ?? null;
    if (!repo?.fullName) return null;
    const provider = (repo.provider ?? '').toLowerCase();
    if (provider !== 'github') return null;
    const issueNumber = feature?.gitHubIssueNumber;
    if (issueNumber == null) return null;
    return `https://github.com/${repo.fullName}/issues/${issueNumber}`;
  }

  /** Build Azure DevOps work item URL using org-level path (IDs are org-scoped). */
  getAzureDevOpsWorkItemUrl(workItemId: number): string | null {
    const repo = this.repository();
    if (!repo?.provider) return null;
    let org: string | undefined;
    if (repo.provider === 'AzureDevOps' && repo.fullName) {
      const parts = repo.fullName.split('/').filter(Boolean);
      if (parts.length >= 1) {
        org = parts[0];
      }
    }
    if (!org) {
      org = this.azureDevOpsOrg() || undefined;
    }
    if (org) {
      return `https://dev.azure.com/${org}/_workitems/edit/${workItemId}`;
    }
    return null;
  }

  openAzureSyncModal(): void {
    if (!this.hasSyncSelection()) return;
    this.showAzureSyncModal.set(true);
    this.azureSyncModalError.set(null);
    this.azureSyncPlanRows.set([]);
    this.azureSyncPlanSuggestedSummary.set(null);
    this.azureSyncProject.set('');
    this.azureSyncTeamId.set('');
    this.azureSyncTeams.set([]);
    this.azureSyncProjects.set([]);
    this.azureSyncOrg.set('');
    this.azureSyncSkippedTarget.set(false);

    const repo = this.repository();
    if (repo?.provider === 'AzureDevOps' && repo.fullName) {
      const parts = repo.fullName.split('/');
      if (parts.length >= 2) {
        this.azureSyncProject.set(parts[1]);
      }
    }

    const skipTarget = this.allSelectedItemsLinkedToAzure();
    this.azureSyncSkippedTarget.set(skipTarget);

    this.authService.getProviderSettings().subscribe({
      next: (settings) => {
        this.azureSyncOrg.set(settings.azureDevOpsOrganization ?? '');
        if (settings.azureDevOpsOrganization) {
          this.loadAzureSyncProjects();
        }
      },
      error: (err) => console.error('Failed to load provider settings:', err)
    });

    if (skipTarget) {
      this.azureSyncStep.set('loading');
      this.fetchAzureSyncPlan();
    } else {
      this.azureSyncStep.set('target');
    }
  }

  closeAzureSyncModal(): void {
    this.showAzureSyncModal.set(false);
    this.azureSyncModalError.set(null);
    this.azureSyncStep.set('target');
    this.azureSyncPlanSuggestedSummary.set(null);
    this.azureSyncSkippedTarget.set(false);
  }

  /** Every selected backlog row already has an Azure DevOps work item id — no “create in Azure” step. */
  private allSelectedItemsLinkedToAzure(): boolean {
    const epics = this.epics();
    const epicSel = this.selectedSyncToAzureEpics();
    const featureSel = this.selectedSyncToAzureFeatures();
    const storySel = this.selectedSyncToAzureStories();
    if (epicSel.size + featureSel.size + storySel.size === 0) return false;

    for (const id of epicSel) {
      const e = epics.find((x) => x.id === id);
      if (!e?.azureDevOpsWorkItemId) return false;
    }
    for (const id of featureSel) {
      let f: Feature | undefined;
      for (const epic of epics) {
        f = epic.features?.find((x) => x.id === id);
        if (f) break;
      }
      if (!f?.azureDevOpsWorkItemId) return false;
    }
    for (const id of storySel) {
      let s: UserStory | undefined;
      outer: for (const epic of epics) {
        for (const feat of epic.features || []) {
          s = feat.userStories?.find((x) => x.id === id);
          if (s) break outer;
        }
      }
      if (!s?.azureDevOpsWorkItemId) return false;
    }
    return true;
  }

  /** Show project picker on plan step (non–Azure DevOps repo or project not inferred). */
  azureSyncShowProjectOnPlanStep(): boolean {
    const repo = this.repository();
    if (repo?.provider !== 'AzureDevOps') return true;
    return !this.azureSyncProject().trim();
  }

  loadAzureSyncProjects(): void {
    this.azureSyncProjectsLoading.set(true);
    this.backlogService.getAzureDevOpsProjects().subscribe({
      next: (projects) => {
        this.azureSyncProjects.set(projects);
        this.azureSyncProjectsLoading.set(false);
        const project = this.azureSyncProject();
        if (project) {
          this.loadAzureSyncTeams(project);
        }
      },
      error: () => {
        this.azureSyncProjectsLoading.set(false);
      }
    });
  }

  onAzureSyncProjectChange(): void {
    this.azureSyncTeamId.set('');
    this.azureSyncTeams.set([]);
    const project = this.azureSyncProject();
    if (project) {
      this.loadAzureSyncTeams(project);
    }
  }

  loadAzureSyncTeams(projectName: string): void {
    this.azureSyncTeamsLoading.set(true);
    this.backlogService.getAzureDevOpsTeams(projectName).subscribe({
      next: (teams) => {
        this.azureSyncTeams.set(teams);
        this.azureSyncTeamsLoading.set(false);
      },
      error: () => {
        this.azureSyncTeamsLoading.set(false);
      }
    });
  }

  continueAzureSyncToPlan(): void {
    if (!this.azureSyncOrg()) {
      this.azureSyncModalError.set('Configure your Azure organization in Settings.');
      return;
    }
    const project = this.azureSyncProject().trim();
    if (!project) {
      this.azureSyncModalError.set('Select a project.');
      return;
    }
    this.azureSyncModalError.set(null);
    this.fetchAzureSyncPlan();
  }

  private fetchAzureSyncPlan(): void {
    const repoId = this.repositoryId();
    if (!repoId) return;
    this.azureSyncPlanLoading.set(true);
    const epicIds = Array.from(this.selectedSyncToAzureEpics());
    const featureIds = Array.from(this.selectedSyncToAzureFeatures());
    const storyIds = Array.from(this.selectedSyncToAzureStories());

    this.backlogService
      .planAzureSync(repoId, { epicIds, featureIds, storyIds })
      .subscribe({
        next: (plan) => {
          this.azureSyncPlanLoading.set(false);
          if (!plan.items?.length) {
            this.azureSyncModalError.set('No matching backlog rows for the current selection.');
            if (this.azureSyncSkippedTarget()) {
              this.azureSyncSkippedTarget.set(false);
              this.azureSyncStep.set('target');
            }
            return;
          }
          const createCount = plan.summary?.create ?? 0;
          if (createCount > 0 && this.azureSyncSkippedTarget()) {
            this.azureSyncSkippedTarget.set(false);
            this.azureSyncStep.set('target');
            this.azureSyncModalError.set(
              'Some selected items are not linked to Azure yet. Choose a project and team, then continue to plan.'
            );
            return;
          }
          this.azureSyncPlanRows.set(
            plan.items.map((it) => ({
              ...it,
              direction: it.suggestedDirection
            }))
          );
          this.azureSyncPlanSuggestedSummary.set(plan.summary ?? null);
          this.azureSyncStep.set('plan');
        },
        error: (err) => {
          this.azureSyncPlanLoading.set(false);
          this.azureSyncModalError.set(err.error?.message || err.message || 'Could not build sync plan.');
          if (this.azureSyncSkippedTarget()) {
            this.azureSyncSkippedTarget.set(false);
            this.azureSyncStep.set('target');
          }
        }
      });
  }

  setAzureSyncRowDirection(
    row: AzureSyncPlanItemResponse & { direction: AzureSyncDirection },
    direction: AzureSyncDirection | string
  ): void {
    const d = direction as AzureSyncDirection;
    if (!row.azureDevOpsWorkItemId && d !== 'create') return;
    if (row.azureDevOpsWorkItemId && d === 'create') return;
    const rows = this.azureSyncPlanRows().map((r) =>
      r.id === row.id && r.entityType === row.entityType ? { ...r, direction: d } : r
    );
    this.azureSyncPlanRows.set(rows);
  }

  backToAzureSyncTarget(): void {
    if (this.azureSyncSkippedTarget()) {
      this.closeAzureSyncModal();
      return;
    }
    this.azureSyncStep.set('target');
    this.azureSyncModalError.set(null);
  }

  submitAzureSyncApply(): void {
    const repoId = this.repositoryId();
    if (!repoId) return;
    const project = this.azureSyncProject().trim();
    if (!project) {
      this.azureSyncModalError.set('Select an Azure project.');
      return;
    }
    const teamId = this.azureSyncTeamId().trim();
    const rows = this.azureSyncPlanRows();
    const createEpicIds: string[] = [];
    const createFeatureIds: string[] = [];
    const createStoryIds: string[] = [];
    const pullEpicIds: string[] = [];
    const pullFeatureIds: string[] = [];
    const pullStoryIds: string[] = [];
    const pushEpicIds: string[] = [];
    const pushFeatureIds: string[] = [];
    const pushStoryIds: string[] = [];

    for (const r of rows) {
      const id = r.id;
      if (r.direction === 'create') {
        if (r.entityType === 'epic') createEpicIds.push(id);
        else if (r.entityType === 'feature') createFeatureIds.push(id);
        else createStoryIds.push(id);
      } else if (r.direction === 'pull') {
        if (r.entityType === 'epic') pullEpicIds.push(id);
        else if (r.entityType === 'feature') pullFeatureIds.push(id);
        else pullStoryIds.push(id);
      } else {
        if (r.entityType === 'epic') pushEpicIds.push(id);
        else if (r.entityType === 'feature') pushFeatureIds.push(id);
        else pushStoryIds.push(id);
      }
    }

    const anyCreate = createEpicIds.length + createFeatureIds.length + createStoryIds.length > 0;
    if (anyCreate && !teamId) {
      this.azureSyncModalError.set('Select a team — it is required to create new work items.');
      return;
    }

    this.azureSyncModalError.set(null);
    this.azureSyncApplyLoading.set(true);

    this.backlogService
      .applyAzureSync(repoId, {
        projectName: project,
        teamId: anyCreate ? teamId : undefined,
        pullEpicIds,
        pullFeatureIds,
        pullStoryIds,
        pushEpicIds,
        pushFeatureIds,
        pushStoryIds,
        createEpicIds,
        createFeatureIds,
        createStoryIds
      })
      .subscribe({
        next: (res) => {
          this.azureSyncApplyLoading.set(false);
          this.closeAzureSyncModal();
          this.azureSyncBannerError.set(null);
          const touched =
            res.createdCount + res.pulledCount + res.pushedCount > 0;
          if (touched) {
            this.loadBacklog(repoId);
          }
          if (res.success) {
            this.azureSyncBannerSuccess.set({
              createdCount: res.createdCount,
              pulledCount: res.pulledCount,
              pushedCount: res.pushedCount,
              failedCount: res.failedCount
            });
          } else {
            this.azureSyncBannerError.set(res.errors?.[0] || 'Some sync operations failed.');
            this.azureSyncBannerSuccess.set(
              touched
                ? {
                    createdCount: res.createdCount,
                    pulledCount: res.pulledCount,
                    pushedCount: res.pushedCount,
                    failedCount: res.failedCount
                  }
                : null
            );
          }
        },
        error: (err) => {
          this.azureSyncApplyLoading.set(false);
          const msg =
            err.error?.message ||
            err.error?.errors?.[0] ||
            (Array.isArray(err.error?.errors) ? err.error.errors.join(' ') : null) ||
            err.message ||
            'Request failed';
          this.azureSyncModalError.set(msg);
        }
      });
  }

  syncToGitHub(): void {
    const repoId = this.repositoryId();
    if (!repoId) return;
    this.syncToGitHubLoading.set(true);
    this.syncToGitHubError.set(null);
    this.syncToGitHubSuccess.set(null);
    const epics = this.epics();
    const epicIds = Array.from(this.selectedSyncToAzureEpics()).filter(() => false); // Epics don't have gitHubIssueNumber in our import
    const featureIds = Array.from(this.selectedSyncToAzureFeatures()).filter(id => {
      for (const e of epics) {
        const f = e.features?.find(x => x.id === id);
        if (f) return f.source === 'GitHub' && f.gitHubIssueNumber != null;
      }
      return false;
    });
    const storyIds = Array.from(this.selectedSyncToAzureStories()).filter(id => {
      for (const e of epics) {
        for (const f of e.features || []) {
          const s = f.userStories?.find(x => x.id === id);
          if (s) return s.source === 'GitHub' && s.gitHubIssueNumber != null;
        }
      }
      return false;
    });
    this.backlogService.syncToGitHub(repoId, { epicIds, featureIds, storyIds }).subscribe({
      next: (res) => {
        this.syncToGitHubLoading.set(false);
        if (res.success) {
          this.syncToGitHubSuccess.set({ syncedCount: res.syncedCount, failedCount: res.failedCount });
        } else {
          this.syncToGitHubError.set(res.errors?.[0] || 'Sync failed');
          this.syncToGitHubSuccess.set(res.syncedCount > 0 ? { syncedCount: res.syncedCount, failedCount: res.failedCount } : null);
        }
      },
      error: (err) => {
        this.syncToGitHubLoading.set(false);
        this.syncToGitHubError.set(err.error?.message || err.message || 'Failed to sync to GitHub');
      }
    });
  }

  openAzureDevOpsImport(): void {
    this.showAzureDevOpsImport.set(true);
    this.azureDevOpsError.set(null);
    this.azureDevOpsWorkItems.set(null);
    this.azureDevOpsProjects.set([]);
    this.azureDevOpsTeams.set([]);
    this.azureDevOpsTeam.set('');
    this.selectedAzureDevOpsEpics.set(new Set());
    this.selectedAzureDevOpsFeatures.set(new Set());
    this.selectedAzureDevOpsStories.set(new Set());
    this.expandedAzureDevOpsItems.set(new Set());

    // Load organization from settings and fetch projects
    this.authService.getProviderSettings().subscribe({
      next: (settings) => {
        if (settings.azureDevOpsOrganization) {
          this.azureDevOpsOrg.set(settings.azureDevOpsOrganization);
          // Fetch available projects
          this.loadAzureDevOpsProjects();
        }
      },
      error: (err) => console.error('Failed to load provider settings:', err)
    });

    // Try to get project name from repository if it's an Azure DevOps repo
    const repo = this.repository();
    if (repo?.provider === 'AzureDevOps' && repo.fullName) {
      // Format: org/project/repo
      const parts = repo.fullName.split('/');
      if (parts.length >= 2) {
        this.azureDevOpsProject.set(parts[1]);
      }
    }
  }

  loadAzureDevOpsProjects(): void {
    this.azureDevOpsProjectsLoading.set(true);
    this.backlogService.getAzureDevOpsProjects().subscribe({
      next: (projects) => {
        this.azureDevOpsProjects.set(projects);
        this.azureDevOpsProjectsLoading.set(false);
        // If a project is already selected (e.g. from repo or previous open), load its teams
        const project = this.azureDevOpsProject();
        if (project) {
          this.loadAzureDevOpsTeams(project);
        }
      },
      error: (err) => {
        console.error('Failed to load Azure DevOps projects:', err);
        this.azureDevOpsProjectsLoading.set(false);
        // Don't show error - user can still type project name manually
      }
    });
  }

  onAzureDevOpsProjectChange(): void {
    const project = this.azureDevOpsProject();
    // Reset team and work items when project changes
    this.azureDevOpsTeam.set('');
    this.azureDevOpsTeams.set([]);
    this.azureDevOpsWorkItems.set(null);
    this.selectedAzureDevOpsEpics.set(new Set());
    
    if (project) {
      this.loadAzureDevOpsTeams(project);
    }
  }

  loadAzureDevOpsTeams(projectName: string): void {
    this.azureDevOpsTeamsLoading.set(true);
    this.backlogService.getAzureDevOpsTeams(projectName).subscribe({
      next: (teams) => {
        this.azureDevOpsTeams.set(teams);
        this.azureDevOpsTeamsLoading.set(false);
      },
      error: (err) => {
        console.error('Failed to load Azure DevOps teams:', err);
        this.azureDevOpsTeamsLoading.set(false);
        // Don't show error - teams are optional
      }
    });
  }

  closeAzureDevOpsImport(): void {
    this.showAzureDevOpsImport.set(false);
    this.azureDevOpsWorkItems.set(null);
    this.azureDevOpsError.set(null);
    this.adoShowAllStatuses.set(false);
    this.adoNameFilter.set('');
  }

  fetchAzureDevOpsWorkItems(): void {
    const org = this.azureDevOpsOrg();
    const project = this.azureDevOpsProject();
    const team = this.azureDevOpsTeam();
    
    if (!project) {
      this.azureDevOpsError.set('Project name is required');
      return;
    }

    if (!team) {
      this.azureDevOpsError.set('Please select a team');
      return;
    }

    if (!org) {
      this.azureDevOpsError.set('Please configure your Azure organization in Settings first');
      return;
    }

    this.azureDevOpsLoading.set(true);
    this.azureDevOpsError.set(null);
    this.adoShowAllStatuses.set(false);
    this.adoNameFilter.set('');

    // Organization and PAT are now retrieved from settings on the backend
    this.backlogService.getAzureDevOpsWorkItems({
      organizationName: org,
      projectName: project,
      teamId: team
    }).subscribe({
      next: (workItems) => {
        this.azureDevOpsWorkItems.set(workItems);
        this.azureDevOpsLoading.set(false);
        
        // Auto-expand all epics
        const expandedSet = new Set<number>();
        workItems.epics.forEach(e => expandedSet.add(e.id));
        this.expandedAzureDevOpsItems.set(expandedSet);
      },
      error: (err) => {
        this.azureDevOpsError.set(err.error?.message || err.message || 'Failed to fetch work items');
        this.azureDevOpsLoading.set(false);
      }
    });
  }

  toggleAzureDevOpsEpicSelection(epicId: number): void {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return;

    const features = this.getAzureDevOpsFeaturesForEpic(epicId);
    const directStories = this.getAzureDevOpsStoriesForEpic(epicId);
    const featureStoryIds = features.flatMap(f => this.getAzureDevOpsStoriesForFeature(f.id).map(s => s.id));
    const allStoryIds = [...directStories.map(s => s.id), ...featureStoryIds];
    const allFeatureIds = features.map(f => f.id);

    const epicSelected = this.selectedAzureDevOpsEpics().has(epicId);
    const selectedEpics = new Set(this.selectedAzureDevOpsEpics());
    const selectedFeatures = new Set(this.selectedAzureDevOpsFeatures());
    const selectedStories = new Set(this.selectedAzureDevOpsStories());

    if (epicSelected) {
      selectedEpics.delete(epicId);
      allFeatureIds.forEach(id => selectedFeatures.delete(id));
      allStoryIds.forEach(id => selectedStories.delete(id));
    } else {
      selectedEpics.add(epicId);
      allFeatureIds.forEach(id => selectedFeatures.add(id));
      allStoryIds.forEach(id => selectedStories.add(id));
    }

    this.selectedAzureDevOpsEpics.set(selectedEpics);
    this.selectedAzureDevOpsFeatures.set(selectedFeatures);
    this.selectedAzureDevOpsStories.set(selectedStories);
  }

  toggleAzureDevOpsItemExpand(itemId: number): void {
    const expanded = new Set(this.expandedAzureDevOpsItems());
    if (expanded.has(itemId)) {
      expanded.delete(itemId);
    } else {
      expanded.add(itemId);
    }
    this.expandedAzureDevOpsItems.set(expanded);
  }

  isAzureDevOpsEpicSelected(epicId: number): boolean {
    return this.selectedAzureDevOpsEpics().has(epicId);
  }

  /** Epic checkbox state: checked (all selected), indeterminate (some selected), unchecked */
  getAzureDevOpsEpicCheckboxState(epicId: number): 'checked' | 'indeterminate' | 'unchecked' {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return 'unchecked';

    const features = this.getAzureDevOpsFeaturesForEpic(epicId);
    const directStories = this.getAzureDevOpsStoriesForEpic(epicId);
    const featureStoryIds = new Set(features.flatMap(f => this.getAzureDevOpsStoriesForFeature(f.id).map(s => s.id)));
    const allStoryIds = [...directStories.map(s => s.id), ...featureStoryIds];
    const allFeatureIds = new Set(features.map(f => f.id));

    const epicSelected = this.selectedAzureDevOpsEpics().has(epicId);
    const selectedFeatureCount = features.filter(f => this.selectedAzureDevOpsFeatures().has(f.id)).length;
    const selectedStoryCount = [...allStoryIds].filter(id => this.selectedAzureDevOpsStories().has(id)).length;

    const totalFeatures = allFeatureIds.size;
    const totalStories = allStoryIds.length;
    const allSelected = epicSelected && selectedFeatureCount === totalFeatures && selectedStoryCount === totalStories;
    const someSelected = epicSelected || selectedFeatureCount > 0 || selectedStoryCount > 0;

    if (allSelected) return 'checked';
    if (someSelected) return 'indeterminate';
    return 'unchecked';
  }

  /** Feature checkbox state: checked (all selected), indeterminate (some selected), unchecked */
  getAzureDevOpsFeatureCheckboxState(featureId: number): 'checked' | 'indeterminate' | 'unchecked' {
    const stories = this.getAzureDevOpsStoriesForFeature(featureId);
    const featureSelected = this.selectedAzureDevOpsFeatures().has(featureId);
    const selectedStoryCount = stories.filter(s => this.selectedAzureDevOpsStories().has(s.id)).length;
    const totalStories = stories.length;

    const allSelected = featureSelected && selectedStoryCount === totalStories;
    const someSelected = featureSelected || selectedStoryCount > 0;

    if (allSelected) return 'checked';
    if (someSelected) return 'indeterminate';
    return 'unchecked';
  }

  isAzureDevOpsItemExpanded(itemId: number): boolean {
    return this.expandedAzureDevOpsItems().has(itemId);
  }

  selectAllAzureDevOpsEpics(): void {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return;
    
    const allIds = new Set(workItems.epics.map(e => e.id));
    this.selectedAzureDevOpsEpics.set(allIds);
  }

  deselectAllAzureDevOpsEpics(): void {
    this.selectedAzureDevOpsEpics.set(new Set());
  }

  private passesAzureDevOpsFilter(item: AzureDevOpsWorkItem): boolean {
    if (!this.adoShowAllStatuses()) {
      const s = (item.state || '').toLowerCase().replace(/\s+/g, '');
      if (['done', 'closed', 'resolved', 'removed'].includes(s)) return false;
    }
    const q = this.adoNameFilter().trim().toLowerCase();
    if (q && !(item.title || '').toLowerCase().includes(q)) return false;
    return true;
  }

  getFilteredAzureDevOpsEpics(): AzureDevOpsWorkItem[] {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return [];
    return workItems.epics.filter(e => this.passesAzureDevOpsFilter(e));
  }

  getFilteredAzureDevOpsFeaturesCount(): number {
    const epics = this.getFilteredAzureDevOpsEpics();
    let count = this.getAzureDevOpsOrphanFeatures().length;
    for (const epic of epics) count += this.getAzureDevOpsFeaturesForEpic(epic.id).length;
    return count;
  }

  getFilteredAzureDevOpsStoriesCount(): number {
    const epics = this.getFilteredAzureDevOpsEpics();
    const orphanFeatures = this.getAzureDevOpsOrphanFeatures();
    let count = this.getAzureDevOpsOrphanStories().length;
    for (const epic of epics) {
      count += this.getAzureDevOpsStoriesForEpic(epic.id).length;
      for (const f of this.getAzureDevOpsFeaturesForEpic(epic.id)) count += this.getAzureDevOpsStoriesForFeature(f.id).length;
    }
    for (const f of orphanFeatures) count += this.getAzureDevOpsStoriesForFeature(f.id).length;
    return count;
  }

  getAzureDevOpsFeaturesForEpic(epicId: number): AzureDevOpsWorkItem[] {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return [];
    return workItems.features.filter(f => f.parentId === epicId && this.passesAzureDevOpsFilter(f));
  }

  getAzureDevOpsStoriesForFeature(featureId: number): AzureDevOpsWorkItem[] {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return [];
    return workItems.userStories.filter(s => s.parentId === featureId && this.passesAzureDevOpsFilter(s));
  }

  getAzureDevOpsStoriesForEpic(epicId: number): AzureDevOpsWorkItem[] {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return [];
    return workItems.userStories.filter(s => s.parentId === epicId && this.passesAzureDevOpsFilter(s));
  }

  /**
   * Get orphan features (features without an epic parent) - filtered
   */
  getAzureDevOpsOrphanFeatures(): AzureDevOpsWorkItem[] {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return [];
    const filteredEpicIds = new Set(this.getFilteredAzureDevOpsEpics().map(e => e.id));
    return workItems.features.filter(f =>
      this.passesAzureDevOpsFilter(f) && (!f.parentId || !filteredEpicIds.has(f.parentId))
    );
  }

  /**
   * Get orphan stories (stories without a feature or epic parent) - filtered
   */
  getAzureDevOpsOrphanStories(): AzureDevOpsWorkItem[] {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return [];
    const epicIds = new Set(workItems.epics.map(e => e.id));
    const featureIds = new Set(workItems.features.map(f => f.id));
    return workItems.userStories.filter(s =>
      this.passesAzureDevOpsFilter(s) &&
      (!s.parentId || (!epicIds.has(s.parentId) && !featureIds.has(s.parentId)))
    );
  }

  // Feature selection (all features) - cascades to stories
  toggleAzureDevOpsFeatureSelection(featureId: number): void {
    const stories = this.getAzureDevOpsStoriesForFeature(featureId);
    const storyIds = stories.map(s => s.id);

    const featureSelected = this.selectedAzureDevOpsFeatures().has(featureId);
    const selectedFeatures = new Set(this.selectedAzureDevOpsFeatures());
    const selectedStories = new Set(this.selectedAzureDevOpsStories());

    if (featureSelected) {
      selectedFeatures.delete(featureId);
      storyIds.forEach(id => selectedStories.delete(id));
    } else {
      selectedFeatures.add(featureId);
      storyIds.forEach(id => selectedStories.add(id));
    }

    this.selectedAzureDevOpsFeatures.set(selectedFeatures);
    this.selectedAzureDevOpsStories.set(selectedStories);
  }

  isAzureDevOpsFeatureSelected(featureId: number): boolean {
    return this.selectedAzureDevOpsFeatures().has(featureId);
  }

  // Story selection (all stories)
  toggleAzureDevOpsStorySelection(storyId: number): void {
    const selected = new Set(this.selectedAzureDevOpsStories());
    if (selected.has(storyId)) {
      selected.delete(storyId);
    } else {
      selected.add(storyId);
    }
    this.selectedAzureDevOpsStories.set(selected);
  }

  isAzureDevOpsStorySelected(storyId: number): boolean {
    return this.selectedAzureDevOpsStories().has(storyId);
  }

  /**
   * Select all visible (filtered) items
   */
  selectAllAzureDevOpsItems(): void {
    const epics = this.getFilteredAzureDevOpsEpics();
    const epicIds = new Set(epics.map(e => e.id));
    const features: AzureDevOpsWorkItem[] = [];
    const stories: AzureDevOpsWorkItem[] = [];

    for (const epic of epics) {
      features.push(...this.getAzureDevOpsFeaturesForEpic(epic.id));
      stories.push(...this.getAzureDevOpsStoriesForEpic(epic.id));
    }
    for (const feature of features) {
      stories.push(...this.getAzureDevOpsStoriesForFeature(feature.id));
    }
    for (const orphan of this.getAzureDevOpsOrphanFeatures()) {
      features.push(orphan);
      stories.push(...this.getAzureDevOpsStoriesForFeature(orphan.id));
    }
    stories.push(...this.getAzureDevOpsOrphanStories());

    this.selectedAzureDevOpsEpics.set(new Set(epics.map(e => e.id)));
    this.selectedAzureDevOpsFeatures.set(new Set(features.map(f => f.id)));
    this.selectedAzureDevOpsStories.set(new Set(stories.map(s => s.id)));
  }

  /**
   * Deselect all items
   */
  deselectAllAzureDevOpsItems(): void {
    this.selectedAzureDevOpsEpics.set(new Set());
    this.selectedAzureDevOpsFeatures.set(new Set());
    this.selectedAzureDevOpsStories.set(new Set());
  }

  importSelectedAzureDevOpsItems(): void {
    const workItems = this.azureDevOpsWorkItems();
    const selectedEpicIds = Array.from(this.selectedAzureDevOpsEpics());
    const selectedFeatureIds = Array.from(this.selectedAzureDevOpsFeatures());
    const selectedStoryIds = Array.from(this.selectedAzureDevOpsStories());
    const repoId = this.repositoryId();
    
    // Allow import if any items are selected
    const hasSelections = selectedEpicIds.length > 0 || 
                          selectedFeatureIds.length > 0 || 
                          selectedStoryIds.length > 0;
    
    if (!workItems || !hasSelections || !repoId) {
      this.azureDevOpsError.set('Please select at least one item to import (epic, feature, or user story)');
      return;
    }

    this.azureDevOpsImporting.set(true);
    this.azureDevOpsError.set(null);

    this.backlogService.importFromAzureDevOps(
      repoId, 
      workItems, 
      selectedEpicIds,
      selectedFeatureIds,
      selectedStoryIds
    ).subscribe({
      next: () => {
        this.loadBacklog(repoId); // Merge: refresh full backlog (existing + imported)
        this.azureDevOpsImporting.set(false);
        this.closeAzureDevOpsImport();
      },
      error: (err) => {
        this.azureDevOpsError.set(err.error?.message || err.message || 'Failed to import work items');
        this.azureDevOpsImporting.set(false);
      }
    });
  }

  getAzureDevOpsStateClass(state: string): string {
    const s = state.toLowerCase();
    if (s === 'done' || s === 'closed' || s === 'resolved') return 'ado-state-done';
    if (s === 'active' || s === 'in progress') return 'ado-state-active';
    if (s === 'new' || s === 'proposed') return 'ado-state-new';
    return 'ado-state-default';
  }

  // GitHub Import Methods
  openGitHubImport(): void {
    this.showGitHubImport.set(true);
    this.gitHubError.set(null);
    this.gitHubIssues.set(null);
    this.selectedGitHubIssues.set(new Set());
    this.expandedGitHubMilestones.set(new Set());
    this.ghNameFilter.set('');
    this.ghShowAllStatuses.set(false); // Default: Active only
    
    // Auto-fetch if we have the repo info
    this.fetchGitHubIssues();
  }

  closeGitHubImport(): void {
    this.showGitHubImport.set(false);
    this.gitHubIssues.set(null);
    this.gitHubError.set(null);
  }

  fetchGitHubIssues(): void {
    const repo = this.repository();
    if (!repo || repo.provider !== 'GitHub') {
      this.gitHubError.set('Repository information not available');
      return;
    }

    // Parse owner/repo from fullName
    const parts = repo.fullName.split('/');
    if (parts.length < 2) {
      this.gitHubError.set('Invalid repository name format');
      return;
    }

    const owner = parts[0];
    const repoName = parts[1];

    this.gitHubLoading.set(true);
    this.gitHubError.set(null);

    this.backlogService.getGitHubIssues({ owner, repo: repoName }).subscribe({
      next: (issues) => {
        this.gitHubIssues.set(issues);
        this.gitHubLoading.set(false);
        
        // Auto-expand all milestones and unassigned section
        const expandedSet = new Set<number>();
        issues.milestones.forEach(m => expandedSet.add(m.number));
        this.expandedGitHubMilestones.set(expandedSet);
      },
      error: (err) => {
        this.gitHubError.set(err.error?.message || err.message || 'Failed to fetch issues');
        this.gitHubLoading.set(false);
      }
    });
  }

  toggleGitHubMilestoneExpand(milestoneNumber: number): void {
    const expanded = new Set(this.expandedGitHubMilestones());
    if (expanded.has(milestoneNumber)) {
      expanded.delete(milestoneNumber);
    } else {
      expanded.add(milestoneNumber);
    }
    this.expandedGitHubMilestones.set(expanded);
  }

  isGitHubMilestoneExpanded(milestoneNumber: number): boolean {
    return this.expandedGitHubMilestones().has(milestoneNumber);
  }

  getGitHubIssuesForMilestone(milestoneNumber: number): GitHubIssue[] {
    const issues = this.gitHubIssues();
    if (!issues) return [];
    return issues.issues.filter(i => i.milestoneNumber === milestoneNumber);
  }

  private passesGitHubStatusFilter(item: { state: string }): boolean {
    if (!this.ghShowAllStatuses()) {
      const s = (item.state || '').toLowerCase();
      if (s === 'closed') return false;
    }
    return true;
  }

  /** Filter milestones and issues by status (open/closed) and name */
  getFilteredGitHubMilestones(): GitHubMilestone[] {
    const issues = this.gitHubIssues();
    const q = this.ghNameFilter().trim().toLowerCase();
    if (!issues) return [];
    let list = issues.milestones.filter(m => this.passesGitHubStatusFilter(m));
    if (q) {
      list = list.filter(m => {
        const matchMilestone = m.title.toLowerCase().includes(q);
        const childIssues = this.getFilteredGitHubIssuesForMilestone(m.number);
        const matchChild = childIssues.some(i => i.title.toLowerCase().includes(q));
        return matchMilestone || matchChild;
      });
    }
    return list;
  }

  getFilteredGitHubIssuesForMilestone(milestoneNumber: number): GitHubIssue[] {
    const list = this.getGitHubIssuesForMilestone(milestoneNumber).filter(i => this.passesGitHubStatusFilter(i));
    const q = this.ghNameFilter().trim().toLowerCase();
    if (!q) return list;
    return list.filter(i => i.title.toLowerCase().includes(q));
  }

  getFilteredGitHubUnassignedIssues(): GitHubIssue[] {
    const issues = this.gitHubIssues();
    if (!issues) return [];
    const list = issues.unassignedIssues.filter(i => this.passesGitHubStatusFilter(i));
    const q = this.ghNameFilter().trim().toLowerCase();
    if (!q) return list;
    return list.filter(i => i.title.toLowerCase().includes(q));
  }

  getGitHubEpicsCount(): number {
    return this.getFilteredGitHubMilestones().length;
  }

  getGitHubFeaturesCount(): number {
    const milestones = this.getFilteredGitHubMilestones();
    let count = 0;
    for (const m of milestones) {
      count += this.getFilteredGitHubIssuesForMilestone(m.number).filter(i =>
        this.hasGitHubLabel(i, 'feature') || this.hasGitHubLabel(i, 'enhancement')
      ).length;
    }
    count += this.getFilteredGitHubUnassignedIssues().filter(i =>
      this.hasGitHubLabel(i, 'feature') || this.hasGitHubLabel(i, 'enhancement')
    ).length;
    return count;
  }

  getGitHubStoriesCount(): number {
    const milestones = this.getFilteredGitHubMilestones();
    let count = 0;
    for (const m of milestones) {
      count += this.getFilteredGitHubIssuesForMilestone(m.number).filter(i =>
        !this.hasGitHubLabel(i, 'feature') && !this.hasGitHubLabel(i, 'enhancement')
      ).length;
    }
    count += this.getFilteredGitHubUnassignedIssues().filter(i =>
      !this.hasGitHubLabel(i, 'feature') && !this.hasGitHubLabel(i, 'enhancement')
    ).length;
    return count;
  }

  /** Checkbox state for "Unassigned" group (issues without milestone) */
  getGitHubUnassignedCheckboxState(): 'checked' | 'indeterminate' | 'unchecked' {
    const issues = this.getFilteredGitHubUnassignedIssues();
    if (issues.length === 0) return 'unchecked';
    const selected = issues.filter(i => this.selectedGitHubIssues().has(i.number)).length;
    if (selected === issues.length) return 'checked';
    if (selected > 0) return 'indeterminate';
    return 'unchecked';
  }

  toggleGitHubUnassignedSelection(): void {
    const issues = this.getFilteredGitHubUnassignedIssues();
    const state = this.getGitHubUnassignedCheckboxState();
    const selected = new Set(this.selectedGitHubIssues());
    if (state === 'checked') {
      issues.forEach(i => selected.delete(i.number));
    } else {
      issues.forEach(i => selected.add(i.number));
    }
    this.selectedGitHubIssues.set(selected);
  }

  /** Epic checkbox state: checked (all selected), indeterminate (some), unchecked (none) */
  getGitHubMilestoneCheckboxState(milestoneNumber: number): 'checked' | 'indeterminate' | 'unchecked' {
    const issues = this.getFilteredGitHubIssuesForMilestone(milestoneNumber);
    if (issues.length === 0) return 'unchecked';
    const selected = issues.filter(i => this.selectedGitHubIssues().has(i.number)).length;
    if (selected === issues.length) return 'checked';
    if (selected > 0) return 'indeterminate';
    return 'unchecked';
  }

  toggleGitHubMilestoneSelection(milestoneNumber: number): void {
    const issues = this.getFilteredGitHubIssuesForMilestone(milestoneNumber);
    const state = this.getGitHubMilestoneCheckboxState(milestoneNumber);
    const selected = new Set(this.selectedGitHubIssues());
    if (state === 'checked') {
      issues.forEach(i => selected.delete(i.number));
    } else {
      issues.forEach(i => selected.add(i.number));
    }
    this.selectedGitHubIssues.set(selected);
  }

  toggleGitHubIssueSelection(issueNumber: number): void {
    const selected = new Set(this.selectedGitHubIssues());
    if (selected.has(issueNumber)) {
      selected.delete(issueNumber);
    } else {
      selected.add(issueNumber);
    }
    this.selectedGitHubIssues.set(selected);
  }

  isGitHubIssueSelected(issueNumber: number): boolean {
    return this.selectedGitHubIssues().has(issueNumber);
  }

  selectAllGitHubItems(): void {
    const milestones = this.getFilteredGitHubMilestones();
    const selected = new Set<number>();
    for (const m of milestones) {
      this.getFilteredGitHubIssuesForMilestone(m.number).forEach(i => selected.add(i.number));
    }
    this.getFilteredGitHubUnassignedIssues().forEach(i => selected.add(i.number));
    this.selectedGitHubIssues.set(selected);
  }

  deselectAllGitHubItems(): void {
    this.selectedGitHubIssues.set(new Set());
  }

  importSelectedGitHubItems(): void {
    const issues = this.gitHubIssues();
    const selectedIssueNumbers = Array.from(this.selectedGitHubIssues());
    const repoId = this.repositoryId();
    
    if (!issues || !repoId) {
      this.gitHubError.set('Missing required data');
      return;
    }

    if (selectedIssueNumbers.length === 0) {
      this.gitHubError.set('Please select at least one item to import');
      return;
    }

    this.gitHubImporting.set(true);
    this.gitHubError.set(null);

    this.backlogService.importFromGitHub(repoId, issues, selectedIssueNumbers).subscribe({
      next: () => {
        this.loadBacklog(repoId); // Merge: refresh full backlog (existing + imported)
        this.gitHubImporting.set(false);
        this.closeGitHubImport();
      },
      error: (err) => {
        this.gitHubError.set(err.error?.message || err.message || 'Failed to import issues');
        this.gitHubImporting.set(false);
      }
    });
  }

  getGitHubStateClass(state: string): string {
    const s = state.toLowerCase();
    if (s === 'closed') return 'gh-state-closed';
    if (s === 'open') return 'gh-state-open';
    return 'gh-state-default';
  }

  hasGitHubLabel(issue: GitHubIssue, label: string): boolean {
    return issue.labels.some(l => l.toLowerCase() === label.toLowerCase());
  }

  // Lightbox: intercept clicks on images inside markdown-content
  @HostListener('click', ['$event'])
  onHostClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target.tagName === 'IMG' && target.closest('.markdown-content')) {
      event.preventDefault();
      event.stopPropagation();
      this.lightboxImageSrc = (target as HTMLImageElement).src;
    }
  }

  closeLightbox() {
    this.lightboxImageSrc = null;
  }

  /**
   * Azure DevOps rich-text fields use HTML. Detect so we can sanitize+render instead of markdown/plain parsing.
   */
  isAdoRichText(value: string | null | undefined): boolean {
    if (!value || value.length < 3) return false;
    const t = value.trim();
    return /<[a-z][\s\S]*>/i.test(t);
  }

  /** Description / epic text: HTML from Azure DevOps or markdown/plain for others. */
  richDescriptionHtml(text: string | null | undefined, fallback: string): SafeHtml {
    const raw = (text?.trim() ? text : fallback) ?? '';
    if (!raw.trim()) {
      return this.sanitizer.bypassSecurityTrustHtml('');
    }
    if (this.isAdoRichText(raw)) {
      const cleaned = this.sanitizer.sanitize(SecurityContext.HTML, raw) ?? '';
      return this.sanitizer.bypassSecurityTrustHtml(cleaned);
    }
    return this.markdownPipe.transform(raw);
  }

  /** Acceptance criteria when stored as Azure HTML. */
  richAcceptanceCriteriaHtml(ac: string | null | undefined): SafeHtml {
    const raw = ac?.trim() ?? '';
    const cleaned = this.sanitizer.sanitize(SecurityContext.HTML, raw) ?? '';
    return this.sanitizer.bypassSecurityTrustHtml(cleaned);
  }

  /**
   * Split acceptance criteria into individual lines. Azure DevOps often exports
   * multiple criteria on one line: "- Given …, when …, then …. - Given …, when …"
   */
  private splitAcceptanceCriteriaLines(ac: string): string[] {
    const lines: string[] = [];
    for (const para of ac.trim().split(/\n+/)) {
      const p = para.trim();
      if (!p) continue;
      const segments = p.split(/\s+-\s+Given\s+/i).map(s => s.trim()).filter(Boolean);
      segments.forEach((seg, idx) => {
        const normalized =
          idx === 0 ? seg.replace(/^[-•*]\s*/, '').trim() : `Given ${seg}`;
        if (normalized.length > 0) {
          lines.push(normalized);
        }
      });
    }
    return lines;
  }

  /** Strip HTML tags and convert <br>, </p>, </div>, </li> to newlines for plain-text parsing. */
  private stripHtmlToText(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .trim();
  }

  parseCriteria(ac: string | undefined | null): { given: string; when: string; then: string; raw: string }[] {
    if (!ac?.trim()) return [];
    const plain = this.isAdoRichText(ac) ? this.stripHtmlToText(ac) : ac;
    if (!plain.trim()) return [];
    const criterionLines = this.splitAcceptanceCriteriaLines(plain);
    return criterionLines.map(line => {
      const givenMatch = line.match(/^Given\s+(.+?)(?:,\s*When\s+|$)/is);
      const whenMatch = line.match(/,\s*When\s+(.+?)(?:,\s*Then\s+|$)/is);
      const thenMatch = line.match(/,\s*Then\s+(.+)$/is);
      return {
        given: givenMatch?.[1]?.trim() || '',
        when: whenMatch?.[1]?.trim() || '',
        then: thenMatch?.[1]?.trim().replace(/\.\s*$/, '') || '',
        raw: line
      };
    });
  }

  openRulesEditor(): void {
    const repo = this.repository();
    if (!repo) return;
    this.rulesLoading.set(true);
    this.rulesViewMode.set('preview');
    this.showRulesModal.set(true);
    this.repositoryService.getRepositoryAgentRules(repo.id).subscribe({
      next: (result) => {
        this.rulesEditText.set(result.agentRules ?? DEFAULT_AGENT_RULES);
        this.rulesIsDefault.set(result.isDefault);
        this.rulesLoading.set(false);
      },
      error: () => {
        this.rulesEditText.set(repo.agentRules ?? DEFAULT_AGENT_RULES);
        this.rulesIsDefault.set(!repo.agentRules);
        this.rulesLoading.set(false);
      }
    });
  }

  closeRulesEditor(): void {
    this.showRulesModal.set(false);
    this.rulesEditText.set('');
    this.rulesViewMode.set('preview');
    this.rulesSaving.set(false);
    this.rulesLoading.set(false);
  }

  saveRules(): void {
    const repo = this.repository();
    if (!repo) return;
    this.rulesSaving.set(true);
    const text = this.rulesEditText();
    this.repositoryService.updateRepositoryAgentRules(repo.id, text).subscribe({
      next: () => {
        this.rulesIsDefault.set(false);
        this.rulesSaving.set(false);
        this.repository.update(r => r ? { ...r, agentRules: text } : r);
      },
      error: () => {
        this.rulesSaving.set(false);
      }
    });
  }

  private azureIdentityWarningDismissStorageKey(repositoryId: string): string {
    return `${BacklogComponent.AZURE_IDENTITY_WARNING_DISMISS_STORAGE_PREFIX}${repositoryId}`;
  }

  private readAzureIdentityWarningDismissedFromStorage(repositoryId: string): boolean {
    if (typeof sessionStorage === 'undefined') return false;
    try {
      return sessionStorage.getItem(this.azureIdentityWarningDismissStorageKey(repositoryId)) === '1';
    } catch {
      return false;
    }
  }

  refreshAzureIdentityWarningDismissedFromStorage(repositoryId: string): void {
    this.azureIdentityWarningDismissed.set(this.readAzureIdentityWarningDismissedFromStorage(repositoryId));
  }

  dismissAzureIdentityWarning(): void {
    const id = this.repositoryId();
    if (!id) return;
    try {
      sessionStorage.setItem(this.azureIdentityWarningDismissStorageKey(id), '1');
    } catch {
      /* storage unavailable */
    }
    this.azureIdentityWarningDismissed.set(true);
  }

  private clearAzureIdentityWarningDismissalForRepo(repositoryId: string): void {
    try {
      sessionStorage.removeItem(this.azureIdentityWarningDismissStorageKey(repositoryId));
    } catch {
      /* ignore */
    }
    if (this.repositoryId() === repositoryId) {
      this.azureIdentityWarningDismissed.set(false);
    }
  }

  openAzureIdentityModal(): void {
    const repo = this.repository();
    if (!repo) return;
    this.azureIdentityError.set(null);
    this.azureIdentityVerifySuccess.set(null);
    this.azureIdentityVerifyError.set(null);
    this.azureIdentityVerifying.set(false);
    this.showAzureIdentityModal.set(true);
    this.azureIdentityClientId.set(repo.azureIdentityClientId || '');
    this.azureIdentityTenantId.set(repo.azureIdentityTenantId || '');
    this.azureIdentityClientSecret.set('');
    this.azureIdentityHasSecret.set(false);
    this.azureIdentityLoading.set(true);

    this.repositoryService.getAzureIdentity(repo.id).subscribe({
      next: (res) => {
        this.azureIdentityClientId.set(res.clientId || '');
        this.azureIdentityTenantId.set(res.tenantId || '');
        this.azureIdentityHasSecret.set(res.hasSecret);
        this.azureIdentityLoading.set(false);
      },
      error: () => {
        this.azureIdentityLoading.set(false);
      }
    });
  }

  closeAzureIdentityModal(): void {
    this.showAzureIdentityModal.set(false);
    this.azureIdentityClientId.set('');
    this.azureIdentityClientSecret.set('');
    this.azureIdentityTenantId.set('');
    this.azureIdentityHasSecret.set(false);
    this.azureIdentitySaving.set(false);
    this.azureIdentityError.set(null);
    this.azureIdentityVerifying.set(false);
    this.azureIdentityVerifySuccess.set(null);
    this.azureIdentityVerifyError.set(null);
  }

  /** Calls API to obtain an Entra ID token with the current (or saved) credentials. */
  verifyAzureIdentityConnection(): void {
    const repo = this.repository();
    if (!repo) return;
    this.azureIdentityVerifySuccess.set(null);
    this.azureIdentityVerifyError.set(null);
    this.azureIdentityError.set(null);

    const cid = this.azureIdentityClientId().trim();
    const tid = this.azureIdentityTenantId().trim();
    const secret = this.azureIdentityClientSecret().trim();

    if (!cid || !tid) {
      this.azureIdentityVerifyError.set('Enter Tenant ID and Client ID before testing.');
      return;
    }
    if (!secret && !this.azureIdentityHasSecret()) {
      this.azureIdentityVerifyError.set('Enter the Client Secret, or save credentials first so a stored secret can be used.');
      return;
    }

    this.azureIdentityVerifying.set(true);
    this.repositoryService
      .verifyAzureIdentity(repo.id, {
        clientId: cid || null,
        tenantId: tid || null,
        clientSecret: secret.length > 0 ? secret : null
      })
      .subscribe({
        next: (res) => {
          this.azureIdentityVerifying.set(false);
          this.azureIdentityVerifySuccess.set(res.message || 'Connection OK.');
        },
        error: (err) => {
          this.azureIdentityVerifying.set(false);
          const body = err?.error;
          const msg =
            (typeof body?.message === 'string' ? body.message : null) ||
            (typeof body?.detail === 'string' ? body.detail : null) ||
            'Verification failed.';
          this.azureIdentityVerifyError.set(msg);
        }
      });
  }

  saveAzureIdentity(): void {
    const repo = this.repository();
    if (!repo) return;

    const clientId = this.azureIdentityClientId().trim() || null;
    const clientSecret = this.azureIdentityClientSecret().trim() || null;
    const tenantId = this.azureIdentityTenantId().trim() || null;

    if ((clientId || tenantId) && (!clientId || !tenantId)) {
      this.azureIdentityError.set('All three fields must be provided together.');
      return;
    }

    const hasExistingSecret = this.azureIdentityHasSecret();
    if (clientId && tenantId && !clientSecret && !hasExistingSecret) {
      this.azureIdentityError.set('Client Secret is required.');
      return;
    }

    this.azureIdentitySaving.set(true);
    this.azureIdentityError.set(null);

    if (!clientId && !tenantId) {
      this.repositoryService.updateAzureIdentity(repo.id, { clientId: null, clientSecret: null, tenantId: null }).subscribe({
        next: () => {
          this.azureIdentitySaving.set(false);
          this.repository.update(r =>
            r
              ? { ...r, azureIdentityClientId: null, azureIdentityTenantId: null, hasAzureIdentity: false }
              : r
          );
          this.clearAzureIdentityWarningDismissalForRepo(repo.id);
          this.closeAzureIdentityModal();
        },
        error: (err) => {
          this.azureIdentityError.set(err.error?.message || 'Failed to update');
          this.azureIdentitySaving.set(false);
        }
      });
      return;
    }

    if (!clientSecret && hasExistingSecret) {
      this.azureIdentitySaving.set(false);
      this.closeAzureIdentityModal();
      return;
    }

    this.repositoryService.updateAzureIdentity(repo.id, { clientId, clientSecret, tenantId }).subscribe({
      next: (res: { hasAzureIdentity?: boolean }) => {
        this.azureIdentitySaving.set(false);
        const has = res?.hasAzureIdentity ?? true;
        this.repository.update(r =>
          r ? { ...r, azureIdentityClientId: clientId, azureIdentityTenantId: tenantId, hasAzureIdentity: has } : r
        );
        this.closeAzureIdentityModal();
      },
      error: (err) => {
        this.azureIdentityError.set(err.error?.message || 'Failed to save Azure identity');
        this.azureIdentitySaving.set(false);
      }
    });
  }

  removeAzureIdentity(): void {
    const repo = this.repository();
    if (!repo) return;
    this.azureIdentitySaving.set(true);
    this.azureIdentityError.set(null);
    this.repositoryService.updateAzureIdentity(repo.id, { clientId: null, clientSecret: null, tenantId: null }).subscribe({
      next: () => {
        this.azureIdentitySaving.set(false);
        this.repository.update(r =>
          r
            ? { ...r, azureIdentityClientId: null, azureIdentityTenantId: null, hasAzureIdentity: false }
            : r
        );
        this.clearAzureIdentityWarningDismissalForRepo(repo.id);
        this.closeAzureIdentityModal();
      },
      error: (err) => {
        this.azureIdentityError.set(err.error?.message || 'Failed to remove Azure identity');
        this.azureIdentitySaving.set(false);
      }
    });
  }

  resetRulesToDefault(): void {
    const repo = this.repository();
    if (!repo) return;
    this.rulesSaving.set(true);
    this.repositoryService.updateRepositoryAgentRules(repo.id, null).subscribe({
      next: () => {
        this.rulesEditText.set(DEFAULT_AGENT_RULES);
        this.rulesIsDefault.set(true);
        this.rulesSaving.set(false);
        this.repository.update(r => r ? { ...r, agentRules: null } : r);
      },
      error: () => {
        this.rulesSaving.set(false);
      }
    });
  }
}
