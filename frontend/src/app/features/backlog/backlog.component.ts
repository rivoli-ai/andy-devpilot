import { Component, OnInit, OnDestroy, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { BacklogService, AzureDevOpsWorkItem, AzureDevOpsWorkItemsHierarchy, AzureDevOpsProject, AzureDevOpsTeam, GitHubIssue, GitHubMilestone, GitHubIssuesHierarchy, STANDALONE_EPIC_TITLE } from '../../core/services/backlog.service';
import { RepositoryService } from '../../core/services/repository.service';
import { Repository } from '../../shared/models/repository.model';
import { SandboxService } from '../../core/services/sandbox.service';
import { SandboxBridgeService, ZedConversation } from '../../core/services/sandbox-bridge.service';
import { VncViewerService } from '../../core/services/vnc-viewer.service';
import { AIConfigService } from '../../core/services/ai-config.service';
import { AuthService } from '../../core/services/auth.service';
import { getVncHtmlUrl, VPS_CONFIG } from '../../core/config/vps.config';
import { Epic } from '../../shared/models/epic.model';
import { Feature } from '../../shared/models/feature.model';
import { UserStory } from '../../shared/models/user-story.model';
import { AddBacklogItemModalComponent, AddItemType, EditItemData } from '../../components/add-backlog-item-modal/add-backlog-item-modal.component';
import { Subject, interval, takeUntil, filter, switchMap } from 'rxjs';

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
  imports: [CommonModule, FormsModule, RouterLink, AddBacklogItemModalComponent],
  templateUrl: './backlog.component.html',
  styleUrl: './backlog.component.css'
})
export class BacklogComponent implements OnInit, OnDestroy {
  epics = signal<Epic[]>([]);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);
  repositoryId = signal<string>('');
  repositoryName = signal<string>('');
  repository = signal<Repository | null>(null);
  
  // Backlog generation state
  generationState = signal<'idle' | 'creating_sandbox' | 'waiting_sandbox' | 'sending' | 'waiting_response' | 'parsing' | 'saving' | 'complete' | 'error'>('idle');
  generationError = signal<string | null>(null);
  latestResponse = signal<ZedConversation | null>(null);
  promptMode = signal<'general' | 'custom'>('general');
  customInstructions = signal<string>('');
  customPrompt = signal<string>('');
  showPromptOptions = signal<boolean>(false);

  // Add item modal state
  addModalType = signal<AddItemType | null>(null);
  addModalParentId = signal<string | null>(null); // epicId for feature, featureId for story
  editModalData = signal<EditItemData | null>(null); // For edit mode

  // Delete confirmation modal state
  deleteConfirmation = signal<{ type: 'epic' | 'feature' | 'story'; id: string; parentId?: string; title: string } | null>(null);

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

  // GitHub import state
  showGitHubImport = signal<boolean>(false);
  gitHubLoading = signal<boolean>(false);
  gitHubError = signal<string | null>(null);
  gitHubIssues = signal<GitHubIssuesHierarchy | null>(null);
  selectedGitHubMilestones = signal<Set<number>>(new Set());
  expandedGitHubMilestones = signal<Set<number>>(new Set());
  includeGitHubUnassigned = signal<boolean>(false);
  gitHubImporting = signal<boolean>(false);

  private destroy$ = new Subject<void>();
  private lastConversationId: string | null = null;
  private createdSandboxBridgePort: number | null = null;
  
  // UI State
  expandedItems = signal<ExpandedState>({});
  searchQuery = signal<string>('');
  statusFilter = signal<string>('all');
  viewMode = signal<ViewMode>('tree');
  selectedItemId = signal<string | null>(null);
  
  // Sandbox state
  creatingSandboxForStory = signal<string | null>(null);
  openSandboxStoryIds = signal<string[]>([]);

  // Computed stats
  totalEpics = computed(() => this.epics().length);
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

  // Epics for tree view (excludes standalone epic - those render separately without tree)
  filteredEpicsForTree = computed(() =>
    this.filteredEpics().filter(e => e.title !== STANDALONE_EPIC_TITLE)
  );

  // Standalone stories (no epic/feature parent) - rendered without tree structure
  standaloneStoriesForTree = computed(() => {
    const standaloneEpic = this.epics().find(e => e.title === STANDALONE_EPIC_TITLE);
    if (!standaloneEpic) return [];
    const query = this.searchQuery().toLowerCase();
    const status = this.statusFilter();
    const stories: Array<{ story: UserStory; feature: Feature; epic: Epic }> = [];
    for (const feature of standaloneEpic.features) {
      for (const story of feature.userStories) {
        const matchesSearch = !query ||
          story.title.toLowerCase().includes(query) ||
          story.description?.toLowerCase().includes(query);
        const effectiveStatus = this.getEffectiveStoryStatus(story);
        const matchesStatus = status === 'all' ||
          this.normalizeStatus(effectiveStatus) === status.toLowerCase();
        if (matchesSearch && matchesStatus) {
          stories.push({ story, feature, epic: standaloneEpic });
        }
      }
    }
    return stories;
  });

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
    private authService: AuthService
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
    const repoId = this.route.snapshot.paramMap.get('repositoryId');
    if (repoId) {
      this.repositoryId.set(repoId);
      this.loadBacklog(repoId);
      this.loadRepository(repoId);
    } else {
      this.error.set('Repository ID is required');
    }

    // Track which stories have open sandboxes
    this.vncViewerService.viewers$.pipe(
      takeUntil(this.destroy$)
    ).subscribe(viewers => {
      const storyIds = viewers
        .filter(v => v.implementationContext?.storyId)
        .map(v => v.implementationContext!.storyId);
      this.openSandboxStoryIds.set(storyIds);
    });
  }

  loadBacklog(repositoryId: string): void {
    this.loading.set(true);
    this.error.set(null);

    this.backlogService.getBacklog(repositoryId).subscribe({
      next: (epics) => {
        this.epics.set(epics);
        // Auto-expand first epic
        if (epics.length > 0) {
          this.expandedItems.update(state => ({ ...state, [epics[0].id]: true }));
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
        const repo = repos.find(r => r.id === repositoryId);
        if (repo) {
          this.repository.set(repo);
          this.repositoryName.set(repo.name);
        }
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
        this.backlogService.updateEpic(data.id, data.title, data.description, undefined, repoId).subscribe({
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
        this.backlogService.updateFeature(data.id, data.title, data.description, undefined, repoId).subscribe({
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
          undefined,
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

    // Check if AI is configured
    const aiConfig = this.aiConfigService.defaultProvider();
    if (!aiConfig.apiKey) {
      this.error.set('AI is not configured. Please configure AI settings first.');
      return;
    }

    this.creatingSandboxForStory.set(story.id);
    this.error.set(null);

    const zedSettings = this.aiConfigService.getZedSettingsJson();
    const defaultBranch = repo.defaultBranch || 'main';

    const openSandboxWithBranch = (repoUrl: string, branch: string) => {
      this.createImplementationSandbox(repo, repoUrl, story, featureTitle, epicTitle, aiConfig, zedSettings, branch);
    };

    // If story already has a PR, clone the PR branch so we can continue work
    const resolveBranch = (repoUrl: string) => {
      if (story.prUrl && repo.provider === 'GitHub') {
        console.log('[Sandbox] Fetching PR head branch for:', story.prUrl);
        this.backlogService.getPrHeadBranch(story.prUrl).subscribe({
          next: (res) => {
            console.log('[Sandbox] Using PR branch:', res.branch);
            openSandboxWithBranch(repoUrl, res.branch);
          },
          error: (err) => {
            console.warn('[Sandbox] Failed to get PR branch, using default:', err);
            openSandboxWithBranch(repoUrl, defaultBranch);
          }
        });
        return;
      }
      openSandboxWithBranch(repoUrl, defaultBranch);
    };

    // Fetch authenticated clone URL (with PAT embedded for private repos)
    this.repositoryService.getAuthenticatedCloneUrl(repo.id).subscribe({
      next: (result) => resolveBranch(result.cloneUrl),
      error: (err) => {
        console.error('Failed to get authenticated clone URL:', err);
        const repoUrl = this.buildRepoCloneUrl(repo);
        resolveBranch(repoUrl);
      }
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
    branch: string
  ): void {
    // Create sandbox (branch may be PR head branch when story already has a PR)
    this.sandboxService.createSandbox({
      repo_url: repoUrl,
      repo_name: repo.name,
      repo_branch: branch,
      ai_config: {
        provider: aiConfig.provider,
        api_key: aiConfig.apiKey,
        model: aiConfig.model,
        base_url: aiConfig.baseUrl
      },
      zed_settings: zedSettings
    }).subscribe({
      next: (sandbox) => {
        console.log('Sandbox created for user story:', story.title);
        
        // Update story status to "InProgress" when sandbox opens
        this.backlogService.updateStoryStatus(story.id, 'InProgress').subscribe({
          next: () => console.log('Story status updated to InProgress'),
          error: (err) => console.warn('Failed to update story status to InProgress:', err)
        });
        
        setTimeout(() => {
          this.creatingSandboxForStory.set(null);
          
          // Open VNC viewer with implementation context for Push & Create PR
          this.vncViewerService.open(
            {
              url: getVncHtmlUrl(sandbox.port),
              autoConnect: true,
              scalingMode: 'local',
              useIframe: true
            },
            sandbox.id,
            `${repo.name} - ${story.title}`,
            sandbox.bridge_port,
            {
              repositoryId: repo.id,
              repositoryFullName: repo.fullName,
              defaultBranch: repo.defaultBranch || 'main',
              storyTitle: story.title,
              storyId: story.id
            }
          );
          
          // Only send implementation prompt for new stories (no existing PR)
          // If PR exists, user is continuing work - let them interact with AI manually
          if (sandbox.bridge_port && !story.prUrl) {
            const bridgePort = sandbox.bridge_port;
            setTimeout(() => {
              const prompt = this.buildImplementationPrompt(story, featureTitle, epicTitle);
              const promptSentTimestamp = Date.now() / 1000; // Convert to seconds for API
              console.log('Sending implementation prompt to Zed...');
              
              this.sandboxBridgeService.sendZedPrompt(bridgePort, prompt).subscribe({
                next: (result) => {
                  console.log('Implementation prompt sent:', result);
                  
                  // Start monitoring for implementation completion
                  this.sandboxBridgeService.waitForImplementationComplete(
                    bridgePort,
                    promptSentTimestamp,
                    5000, // Poll every 5 seconds
                    600000 // 10 minute timeout
                  ).subscribe({
                    next: (conversation) => {
                      console.log('Implementation completed!', conversation);
                      
                      // Mark sandbox as ready for PR (shows alert on minimized widget)
                      this.vncViewerService.setReadyForPrByStoryId(story.id, true);
                    },
                    error: (err) => {
                      console.warn('Failed to detect implementation completion:', err);
                    }
                  });
                },
                error: (err) => {
                  console.warn('Failed to send implementation prompt:', err);
                }
              });
            }, 20000); // 20s for Zed to start
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

    prompt += `
---

Please analyze the codebase and implement this user story. Follow these steps:
1. First, understand the current project structure and architecture
2. Identify the files that need to be created or modified
3. Implement the changes following the project's coding standards
4. Ensure the acceptance criteria are met
5. Add appropriate tests if the project has a testing framework

Start by exploring the codebase and then provide your implementation plan.`;

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
    this.destroy$.next();
    this.destroy$.complete();
  }

  generateBacklog(): void {
    const repo = this.repository();
    if (!repo) {
      this.generationError.set('Repository not found');
      this.generationState.set('error');
      return;
    }

    // Check if AI is configured
    const aiConfig = this.aiConfigService.defaultProvider();
    if (!aiConfig.apiKey) {
      this.generationError.set('AI is not configured. Please configure AI settings first.');
      this.generationState.set('error');
      return;
    }

    // Check for active sandbox (find viewer by repository name)
    const viewers = this.vncViewerService.getViewers();
    const activeSandbox = viewers.find(v => v.title?.includes(repo.name)) || null;
    
    if (activeSandbox?.bridgePort) {
      this.sendBacklogPrompt(activeSandbox.bridgePort);
    } else {
      this.createSandboxAndGenerate();
    }
  }

  private createSandboxAndGenerate(): void {
    const repo = this.repository();
    if (!repo) return;

    this.generationState.set('creating_sandbox');
    this.generationError.set(null);

    const aiConfig = this.aiConfigService.defaultProvider();
    const zedSettings = this.aiConfigService.getZedSettingsJson();

    // Fetch authenticated clone URL (with PAT embedded for private repos)
    this.repositoryService.getAuthenticatedCloneUrl(repo.id).subscribe({
      next: (result) => {
        this.createSandboxWithConfig(repo, result.cloneUrl, aiConfig, zedSettings);
      },
      error: (err) => {
        console.error('Failed to get authenticated clone URL:', err);
        // Fallback to regular clone URL
        const repoUrl = this.buildRepoCloneUrl(repo);
        this.createSandboxWithConfig(repo, repoUrl, aiConfig, zedSettings);
      }
    });
  }

  private createSandboxWithConfig(
    repo: Repository, 
    repoUrl: string, 
    aiConfig: any, 
    zedSettings: object
  ): void {
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
        if (!sandbox.bridge_port) {
          this.generationError.set('Sandbox created but bridge port not available.');
          this.generationState.set('error');
          return;
        }
        
        this.createdSandboxBridgePort = sandbox.bridge_port;
        
        setTimeout(() => {
          this.vncViewerService.open(
            {
              url: getVncHtmlUrl(sandbox.port),
              autoConnect: true,
              scalingMode: 'local',
              useIframe: true
            },
            sandbox.id,
            `${repo.name}`,
            sandbox.bridge_port!
          );
          
          this.generationState.set('waiting_sandbox');
          // Send backlog prompt after Zed is ready
          setTimeout(() => {
            this.sendBacklogPrompt(sandbox.bridge_port!);
          }, 20000); // 20s for Zed to start
        }, VPS_CONFIG.sandboxReadyDelayMs);
      },
      error: (err) => {
        this.generationError.set('Failed to create sandbox: ' + (err.message || 'Unknown error'));
        this.generationState.set('error');
      }
    });
  }

  private waitForZedAndSendBacklogPrompt(bridgePort: number): void {
    this.generationState.set('sending');
    const prompt = this.buildBacklogPrompt();
    
    console.log('Waiting for Zed to be ready before sending backlog prompt...');
    this.sandboxBridgeService.waitForZedAndSendPrompt(bridgePort, prompt).subscribe({
      next: (result) => {
        console.log('Backlog prompt sent:', result);
        this.generationState.set('waiting_response');
        this.startPollingForResponse(bridgePort);
      },
      error: (err) => {
        console.warn('Failed to send backlog prompt:', err);
        this.generationError.set('Failed to send prompt to Zed. Please ensure the sandbox is running and Zed is ready.');
        this.generationState.set('error');
      }
    });
  }

  private sendBacklogPrompt(bridgePort: number): void {
    this.generationState.set('sending');
    const prompt = this.buildBacklogPrompt();

    this.sandboxBridgeService.sendZedPrompt(bridgePort, prompt).subscribe({
      next: (result) => {
        this.generationState.set('waiting_response');
        this.startPollingForResponse(bridgePort);
      },
      error: (err) => {
        setTimeout(() => {
          this.sandboxBridgeService.sendZedPrompt(bridgePort, prompt).subscribe({
            next: (result) => {
              this.generationState.set('waiting_response');
              this.startPollingForResponse(bridgePort);
            },
            error: (retryErr) => {
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

  private startPollingForResponse(bridgePort: number): void {
    interval(3000).pipe(
      takeUntil(this.destroy$),
      filter(() => this.generationState() === 'waiting_response'),
      switchMap(() => this.sandboxBridgeService.getLatestZedConversation(bridgePort))
    ).subscribe({
      next: (conv) => {
        if (conv && conv.id !== this.lastConversationId) {
          this.latestResponse.set(conv);
          
          if (this.containsBacklogJson(conv.assistant_message)) {
            this.lastConversationId = conv.id;
            this.parseAndSaveBacklog(conv.assistant_message);
          }
        }
      },
      error: (err) => {
        console.error('Polling error:', err);
      }
    });
  }

  private containsBacklogJson(response: string): boolean {
    return response.includes('"epics"') && (response.includes('```json') || response.includes('"features"'));
  }

  private parseAndSaveBacklog(response: string): void {
    this.generationState.set('parsing');

    try {
      // Extract JSON from markdown code block if present
      let jsonStr = response;
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      const backlog = JSON.parse(jsonStr);
      const repoId = this.repositoryId();

      if (!repoId) {
        throw new Error('Repository ID not found');
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

  getStatusIcon(status: string): string {
    const s = status.toLowerCase();
    if (s === 'done' || s === 'completed' || s === 'closed') return '✓';
    if (s === 'pendingreview' || s === 'pending review' || s === 'review') return '⟳';
    if (s === 'inprogress' || s === 'in progress' || s === 'active') return '►';
    if (s === 'blocked') return '⊘';
    return '○';
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
      case 'epic': return '#8b5cf6'; // Purple
      case 'feature': return '#f59e0b'; // Amber
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
      this.azureDevOpsError.set('Please configure your Azure DevOps organization in Settings first');
      return;
    }

    this.azureDevOpsLoading.set(true);
    this.azureDevOpsError.set(null);

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

  getAzureDevOpsFeaturesForEpic(epicId: number): AzureDevOpsWorkItem[] {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return [];
    return workItems.features.filter(f => f.parentId === epicId);
  }

  getAzureDevOpsStoriesForFeature(featureId: number): AzureDevOpsWorkItem[] {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return [];
    return workItems.userStories.filter(s => s.parentId === featureId);
  }

  getAzureDevOpsStoriesForEpic(epicId: number): AzureDevOpsWorkItem[] {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return [];
    // Stories directly under epic (not via feature)
    return workItems.userStories.filter(s => s.parentId === epicId);
  }

  /**
   * Get orphan features (features without an epic parent)
   */
  getAzureDevOpsOrphanFeatures(): AzureDevOpsWorkItem[] {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return [];
    const epicIds = new Set(workItems.epics.map(e => e.id));
    return workItems.features.filter(f => !f.parentId || !epicIds.has(f.parentId));
  }

  /**
   * Get orphan stories (stories without a feature or epic parent)
   */
  getAzureDevOpsOrphanStories(): AzureDevOpsWorkItem[] {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return [];
    const epicIds = new Set(workItems.epics.map(e => e.id));
    const featureIds = new Set(workItems.features.map(f => f.id));
    return workItems.userStories.filter(s => 
      !s.parentId || (!epicIds.has(s.parentId) && !featureIds.has(s.parentId))
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
   * Select all items (epics, all features, all stories)
   */
  selectAllAzureDevOpsItems(): void {
    const workItems = this.azureDevOpsWorkItems();
    if (!workItems) return;
    
    this.selectedAzureDevOpsEpics.set(new Set(workItems.epics.map(e => e.id)));
    this.selectedAzureDevOpsFeatures.set(new Set(workItems.features.map(f => f.id)));
    this.selectedAzureDevOpsStories.set(new Set(workItems.userStories.map(s => s.id)));
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
    this.selectedGitHubMilestones.set(new Set());
    this.expandedGitHubMilestones.set(new Set());
    this.includeGitHubUnassigned.set(false);
    
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
        
        // Auto-expand all milestones
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

  toggleGitHubMilestoneSelection(milestoneNumber: number): void {
    const selected = new Set(this.selectedGitHubMilestones());
    if (selected.has(milestoneNumber)) {
      selected.delete(milestoneNumber);
    } else {
      selected.add(milestoneNumber);
    }
    this.selectedGitHubMilestones.set(selected);
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

  isGitHubMilestoneSelected(milestoneNumber: number): boolean {
    return this.selectedGitHubMilestones().has(milestoneNumber);
  }

  isGitHubMilestoneExpanded(milestoneNumber: number): boolean {
    return this.expandedGitHubMilestones().has(milestoneNumber);
  }

  selectAllGitHubMilestones(): void {
    const issues = this.gitHubIssues();
    if (!issues) return;
    
    const allIds = new Set(issues.milestones.map(m => m.number));
    this.selectedGitHubMilestones.set(allIds);
  }

  deselectAllGitHubMilestones(): void {
    this.selectedGitHubMilestones.set(new Set());
  }

  getGitHubIssuesForMilestone(milestoneNumber: number): GitHubIssue[] {
    const issues = this.gitHubIssues();
    if (!issues) return [];
    return issues.issues.filter(i => i.milestoneNumber === milestoneNumber);
  }

  importSelectedGitHubItems(): void {
    const issues = this.gitHubIssues();
    const selectedMilestones = Array.from(this.selectedGitHubMilestones());
    const repoId = this.repositoryId();
    const includeUnassigned = this.includeGitHubUnassigned();
    
    if (!issues || !repoId) {
      this.gitHubError.set('Missing required data');
      return;
    }

    if (selectedMilestones.length === 0 && !includeUnassigned) {
      this.gitHubError.set('Please select at least one milestone or include unassigned issues');
      return;
    }

    this.gitHubImporting.set(true);
    this.gitHubError.set(null);

    this.backlogService.importFromGitHub(repoId, issues, selectedMilestones, includeUnassigned).subscribe({
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
}
