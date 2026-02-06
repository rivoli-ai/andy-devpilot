import { Injectable, signal } from '@angular/core';
import { Observable, tap, switchMap, firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { Epic } from '../../shared/models/epic.model';
import { Feature } from '../../shared/models/feature.model';
import { UserStory } from '../../shared/models/user-story.model';

/** Epic title used for standalone user stories (no epic/feature parent). Rendered without tree. */
export const STANDALONE_EPIC_TITLE = '__Standalone__';

export interface CreateBacklogRequest {
  epics: {
    title: string;
    description: string;
    azureDevOpsWorkItemId?: number;
    features: {
      title: string;
      description: string;
      azureDevOpsWorkItemId?: number;
      userStories: {
        title: string;
        description: string;
        acceptanceCriteria: string[];
        storyPoints?: number;
        azureDevOpsWorkItemId?: number;
      }[];
    }[];
  }[];
}

/**
 * Service for managing backlog (Epics, Features, User Stories)
 * Uses signals for reactive state management
 */
@Injectable({
  providedIn: 'root'
})
export class BacklogService {
  private readonly backlogSignal = signal<Epic[]>([]);
  
  // Expose readonly signal
  readonly backlog = this.backlogSignal.asReadonly();

  constructor(private apiService: ApiService) {}

  /**
   * Fetch backlog for a repository
   */
  getBacklog(repositoryId: string): Observable<Epic[]> {
    return this.apiService.get<Epic[]>(`/backlog/repository/${repositoryId}`).pipe(
      tap(epics => this.backlogSignal.set(epics))
    );
  }

  /**
   * Create backlog from AI-generated data
   */
  createBacklog(repositoryId: string, backlog: CreateBacklogRequest): Observable<Epic[]> {
    return this.apiService.post<Epic[]>(`/backlog/repository/${repositoryId}`, backlog).pipe(
      tap(epics => this.backlogSignal.set(epics))
    );
  }

  /**
   * Clear current backlog signal
   */
  clearBacklog(): void {
    this.backlogSignal.set([]);
  }

  /**
   * Update a user story's status and optionally the PR URL
   */
  updateStoryStatus(storyId: string, status: string, prUrl?: string): Observable<{ success: boolean; storyId: string; status: string; prUrl?: string }> {
    return this.apiService.patch<{ success: boolean; storyId: string; status: string; prUrl?: string }>(
      `/backlog/story/${storyId}/status`,
      { status, prUrl }
    ).pipe(
      tap(response => {
        if (response.success) {
          // Update local signal
          const epics = this.backlogSignal();
          const updatedEpics = epics.map(epic => ({
            ...epic,
            features: epic.features.map(feature => ({
              ...feature,
              userStories: feature.userStories.map(story =>
                story.id === storyId ? { ...story, status, prUrl: prUrl || story.prUrl } : story
              )
            }))
          }));
          this.backlogSignal.set(updatedEpics);
        }
      })
    );
  }

  /**
   * Get the head (source) branch name of a pull request from its URL.
   * Used when opening a story that already has a PR so the sandbox can clone that branch.
   * The backend uses the authenticated user's GitHub token from the database.
   */
  getPrHeadBranch(prUrl: string): Observable<{ branch: string }> {
    return this.apiService.post<{ branch: string }>('/backlog/pr-head-branch', { prUrl });
  }

  /**
   * Use AI to suggest improved description or acceptance criteria for a backlog item.
   * Requires AI to be configured (API key set).
   */
  suggestWithAI(
    field: 'description' | 'acceptanceCriteria',
    itemType: string,
    title: string,
    currentContent?: string,
    description?: string
  ): Observable<{ suggestion: string }> {
    return this.apiService.post<{ suggestion: string }>('/backlog/ai/suggest', {
      field,
      itemType,
      title,
      currentContent,
      description
    });
  }

  /**
   * Sync PR statuses for all stories with PRs in a repository
   * Checks GitHub for PR status and updates story status accordingly:
   * - PR open -> PendingReview
   * - PR merged -> Done
   */
  syncPrStatuses(repositoryId: string): Observable<SyncPrStatusResponse> {
    return this.apiService.post<SyncPrStatusResponse>(
      `/backlog/repository/${repositoryId}/sync-pr-status`,
      {}
    ).pipe(
      tap(response => {
        if (response.success && response.updatedCount > 0) {
          // Refresh the backlog to get updated statuses
          this.getBacklog(repositoryId).subscribe();
        }
      })
    );
  }

  /**
   * Add a new Epic
   * @param source Optional: "Manual" | "AzureDevOps" | "GitHub"
   * @param azureDevOpsWorkItemId Optional: Azure DevOps work item ID when imported from ADO
   */
  addEpic(repositoryId: string, title: string, description?: string, source?: string, azureDevOpsWorkItemId?: number): Observable<Epic> {
    const body: { title: string; description?: string; source?: string; azureDevOpsWorkItemId?: number } = { title, description };
    if (source) body.source = source;
    if (azureDevOpsWorkItemId != null) body.azureDevOpsWorkItemId = azureDevOpsWorkItemId;
    return this.apiService.post<Epic>(`/backlog/repository/${repositoryId}/epic`, body).pipe(
      tap(() => this.getBacklog(repositoryId).subscribe())
    );
  }

  /**
   * Add a new Feature to an Epic
   * @param source Optional: "Manual" | "AzureDevOps" | "GitHub"
   * @param azureDevOpsWorkItemId Optional: Azure DevOps work item ID when imported from ADO
   */
  addFeature(epicId: string, title: string, description?: string, repositoryId?: string, source?: string, azureDevOpsWorkItemId?: number): Observable<Feature> {
    const body: { title: string; description?: string; source?: string; azureDevOpsWorkItemId?: number } = { title, description };
    if (source) body.source = source;
    if (azureDevOpsWorkItemId != null) body.azureDevOpsWorkItemId = azureDevOpsWorkItemId;
    return this.apiService.post<Feature>(`/backlog/epic/${epicId}/feature`, body).pipe(
      tap(() => repositoryId && this.getBacklog(repositoryId).subscribe())
    );
  }

  /**
   * Add a new User Story to a Feature
   * @param source Optional: "Manual" | "AzureDevOps" | "GitHub"
   * @param azureDevOpsWorkItemId Optional: Azure DevOps work item ID when imported from ADO
   */
  addUserStory(
    featureId: string,
    title: string,
    description?: string,
    acceptanceCriteria?: string,
    storyPoints?: number,
    repositoryId?: string,
    source?: string,
    azureDevOpsWorkItemId?: number
  ): Observable<UserStory> {
    const body: { title: string; description?: string; acceptanceCriteria?: string; storyPoints?: number; source?: string; azureDevOpsWorkItemId?: number } = {
      title,
      description,
      acceptanceCriteria,
      storyPoints
    };
    if (source) body.source = source;
    if (azureDevOpsWorkItemId != null) body.azureDevOpsWorkItemId = azureDevOpsWorkItemId;
    return this.apiService.post<UserStory>(`/backlog/feature/${featureId}/story`, body).pipe(
      tap(() => repositoryId && this.getBacklog(repositoryId).subscribe())
    );
  }

  /**
   * Delete an Epic
   */
  deleteEpic(epicId: string, repositoryId: string): Observable<{ success: boolean }> {
    return this.apiService.delete<{ success: boolean }>(`/backlog/epic/${epicId}`);
  }

  /**
   * Delete a Feature
   */
  deleteFeature(featureId: string, repositoryId: string): Observable<{ success: boolean }> {
    return this.apiService.delete<{ success: boolean }>(`/backlog/feature/${featureId}`);
  }

  /**
   * Delete a User Story
   */
  deleteUserStory(storyId: string, repositoryId: string): Observable<{ success: boolean }> {
    return this.apiService.delete<{ success: boolean }>(`/backlog/story/${storyId}`);
  }

  /**
   * Update an Epic
   */
  updateEpic(epicId: string, title: string, description?: string, status?: string, repositoryId?: string): Observable<Epic> {
    return this.apiService.put<Epic>(`/backlog/epic/${epicId}`, { title, description, status }).pipe(
      tap(() => repositoryId && this.getBacklog(repositoryId).subscribe())
    );
  }

  /**
   * Update a Feature
   */
  updateFeature(featureId: string, title: string, description?: string, status?: string, repositoryId?: string): Observable<Feature> {
    return this.apiService.put<Feature>(`/backlog/feature/${featureId}`, { title, description, status }).pipe(
      tap(() => repositoryId && this.getBacklog(repositoryId).subscribe())
    );
  }

  /**
   * Update a User Story
   */
  updateUserStory(
    storyId: string,
    title: string,
    description?: string,
    acceptanceCriteria?: string,
    storyPoints?: number,
    status?: string,
    repositoryId?: string
  ): Observable<UserStory> {
    return this.apiService.put<UserStory>(`/backlog/story/${storyId}`, {
      title,
      description,
      acceptanceCriteria,
      storyPoints,
      status
    }).pipe(
      tap(() => repositoryId && this.getBacklog(repositoryId).subscribe())
    );
  }

  /**
   * Sync backlog items imported from Azure DevOps back to Azure DevOps
   * Updates title, description, status, story points, acceptance criteria
   */
  syncToAzureDevOps(repositoryId: string): Observable<SyncToAzureDevOpsResponse> {
    return this.apiService.post<SyncToAzureDevOpsResponse>(
      `/backlog/repository/${repositoryId}/sync-to-azure-devops`,
      {}
    ).pipe(
      tap(response => {
        if (response.success && response.syncedCount > 0) {
          this.getBacklog(repositoryId).subscribe();
        }
      })
    );
  }

  /**
   * Check PR status for a single story
   */
  checkStoryPrStatus(storyId: string, accessToken: string): Observable<StoryPrStatusResponse> {
    return this.apiService.get<StoryPrStatusResponse>(
      `/backlog/story/${storyId}/pr-status?accessToken=${encodeURIComponent(accessToken)}`
    ).pipe(
      tap(response => {
        if (response.statusUpdated && response.storyStatus) {
          // Update local signal
          const newStatus = response.storyStatus;
          const epics = this.backlogSignal();
          const updatedEpics = epics.map(epic => ({
            ...epic,
            features: epic.features.map(feature => ({
              ...feature,
              userStories: feature.userStories.map(story =>
                story.id === storyId ? { ...story, status: newStatus } : story
              )
            }))
          }));
          this.backlogSignal.set(updatedEpics);
        }
      })
    );
  }

  /**
   * Fetch Azure DevOps projects for the configured organization
   */
  getAzureDevOpsProjects(): Observable<AzureDevOpsProject[]> {
    return this.apiService.get<AzureDevOpsProject[]>('/repositories/azure-devops/projects');
  }

  /**
   * Fetch Azure DevOps teams for a specific project
   */
  getAzureDevOpsTeams(projectName: string): Observable<AzureDevOpsTeam[]> {
    return this.apiService.get<AzureDevOpsTeam[]>(`/repositories/azure-devops/projects/${encodeURIComponent(projectName)}/teams`);
  }

  /**
   * Fetch work items from Azure DevOps
   */
  getAzureDevOpsWorkItems(request: AzureDevOpsWorkItemsRequest): Observable<AzureDevOpsWorkItemsHierarchy> {
    return this.apiService.post<AzureDevOpsWorkItemsHierarchy>('/repositories/azure-devops/work-items', request);
  }

  /**
   * Find existing epic by title (case-insensitive)
   */
  private findEpicByTitle(epics: Epic[], title: string): Epic | undefined {
    const t = title.toLowerCase().trim();
    return epics.find(e => e.title.toLowerCase().trim() === t);
  }

  /**
   * Find existing feature by title under epic (case-insensitive)
   */
  private findFeatureByTitle(epic: Epic, title: string): Feature | undefined {
    const t = title.toLowerCase().trim();
    return (epic.features ?? []).find(f => f.title.toLowerCase().trim() === t);
  }

  /**
   * Import Azure DevOps work items into the backlog
   * Converts Azure DevOps Epics/Features/User Stories to DevPilot format
   * Granular selection: can select individual epics, features, or stories
   * Reuses existing epics/features when tree already exists (match by title)
   */
  importFromAzureDevOps(
    repositoryId: string,
    workItems: AzureDevOpsWorkItemsHierarchy,
    selectedEpicIds: number[],
    selectedFeatureIds: number[] = [],
    selectedStoryIds: number[] = []
  ): Observable<Epic[]> {
    const backlogRequest: CreateBacklogRequest = {
      epics: []
    };

    const selectedEpicSet = new Set(selectedEpicIds);
    const selectedFeatureSet = new Set(selectedFeatureIds);
    const selectedStorySet = new Set(selectedStoryIds);
    const epicIds = new Set(workItems.epics.map(e => e.id));
    const featureIds = new Set(workItems.features.map(f => f.id));

    // Helper to convert a story
    const convertStory = (adoStory: AzureDevOpsWorkItem) => ({
      title: adoStory.title,
      description: this.stripHtml(adoStory.description || ''),
      acceptanceCriteria: adoStory.acceptanceCriteria
        ? this.parseAcceptanceCriteria(adoStory.acceptanceCriteria)
        : [],
      storyPoints: adoStory.storyPoints,
      azureDevOpsWorkItemId: adoStory.id
    });

    // Helper to convert a feature with only selected stories
    const convertFeatureWithSelectedStories = (adoFeature: AzureDevOpsWorkItem) => {
      const featureStories = workItems.userStories
        .filter(s => s.parentId === adoFeature.id && selectedStorySet.has(s.id));
      return {
        title: adoFeature.title,
        description: this.stripHtml(adoFeature.description || ''),
        azureDevOpsWorkItemId: adoFeature.id,
        userStories: featureStories.map(convertStory)
      };
    };

    // Track which features and stories have been processed (to avoid duplicates)
    const processedFeatures = new Set<number>();
    const processedStories = new Set<number>();

    // 1. Process selected epics
    for (const adoEpic of workItems.epics.filter(e => selectedEpicSet.has(e.id))) {
      const features: { title: string; description: string; userStories: any[] }[] = [];

      // Get features under this epic that are selected
      const epicFeatures = workItems.features.filter(f => 
        f.parentId === adoEpic.id && selectedFeatureSet.has(f.id)
      );

      for (const feature of epicFeatures) {
        features.push(convertFeatureWithSelectedStories(feature));
        processedFeatures.add(feature.id);
        workItems.userStories
          .filter(s => s.parentId === feature.id && selectedStorySet.has(s.id))
          .forEach(s => processedStories.add(s.id));
      }

      // Get direct stories under this epic that are selected
      const epicDirectStories = workItems.userStories.filter(s => 
        s.parentId === adoEpic.id && selectedStorySet.has(s.id)
      );
      if (epicDirectStories.length > 0) {
        features.push({
          title: 'General',
          description: 'User stories from epic',
          userStories: epicDirectStories.map(convertStory)
        });
        epicDirectStories.forEach(s => processedStories.add(s.id));
      }

      if (features.length > 0) {
        backlogRequest.epics.push({
          title: adoEpic.title,
          description: this.stripHtml(adoEpic.description || ''),
          azureDevOpsWorkItemId: adoEpic.id,
          features
        });
      }
    }

    // 2. Process selected features not under a selected epic (orphan or under unselected epic)
    // If feature has epic parent: use epic title so we merge into existing epic tree
    // If orphan: use feature title as epic title
    const remainingFeatures = workItems.features.filter(f => 
      selectedFeatureSet.has(f.id) && !processedFeatures.has(f.id)
    );

    for (const feature of remainingFeatures) {
      processedFeatures.add(feature.id);
      const convertedFeature = convertFeatureWithSelectedStories(feature);
      workItems.userStories
        .filter(s => s.parentId === feature.id && selectedStorySet.has(s.id))
        .forEach(s => processedStories.add(s.id));

      const adoEpic = feature.parentId != null ? workItems.epics.find(e => e.id === feature.parentId) : null;
      const epicTitle = adoEpic ? adoEpic.title : feature.title;
      const epicDesc = adoEpic ? this.stripHtml(adoEpic.description || '') : this.stripHtml(feature.description || '');

      backlogRequest.epics.push({
        title: epicTitle,
        description: epicDesc,
        azureDevOpsWorkItemId: adoEpic?.id,
        features: [convertedFeature]
      });
    }

    // 3. Process selected stories not under a selected epic/feature
    // Split: stories with epic/feature parent → show tree; truly orphan → Standalone
    const remainingStories = workItems.userStories.filter(s => 
      selectedStorySet.has(s.id) && !processedStories.has(s.id)
    );

    const orphanStories: AzureDevOpsWorkItem[] = [];
    const storiesWithEpicParent: Array<{ story: AzureDevOpsWorkItem; epicId: number }> = [];
    const storiesWithFeatureParent: Array<{ story: AzureDevOpsWorkItem; featureId: number }> = [];

    for (const story of remainingStories) {
      const parentId = story.parentId;
      if (parentId == null || parentId === undefined) {
        orphanStories.push(story);
      } else if (epicIds.has(parentId)) {
        storiesWithEpicParent.push({ story, epicId: parentId });
      } else if (featureIds.has(parentId)) {
        storiesWithFeatureParent.push({ story, featureId: parentId });
      } else {
        orphanStories.push(story);
      }
    }

    // 3a. Stories with epic parent (not selected) → create Epic → Feature('General') → Story (tree)
    const epicIdToStories = new Map<number, AzureDevOpsWorkItem[]>();
    for (const { story, epicId } of storiesWithEpicParent) {
      const list = epicIdToStories.get(epicId) ?? [];
      list.push(story);
      epicIdToStories.set(epicId, list);
    }
    for (const [epicId, stories] of epicIdToStories) {
      const adoEpic = workItems.epics.find(e => e.id === epicId)!;
      backlogRequest.epics.push({
        title: adoEpic.title,
        description: this.stripHtml(adoEpic.description || ''),
        azureDevOpsWorkItemId: adoEpic.id,
        features: [{
          title: 'General',
          description: 'User stories from epic',
          userStories: stories.map(convertStory)
        }]
      });
    }

    // 3b. Stories with feature parent (not selected) → create Epic → Feature → Story (tree)
    // Group by feature, then by epic to merge features under same epic
    const featureIdToStories = new Map<number, AzureDevOpsWorkItem[]>();
    for (const { story, featureId } of storiesWithFeatureParent) {
      const list = featureIdToStories.get(featureId) ?? [];
      list.push(story);
      featureIdToStories.set(featureId, list);
    }
    const epicIdToFeatures = new Map<number, Array<{ feature: AzureDevOpsWorkItem; stories: AzureDevOpsWorkItem[] }>>();
    for (const [featureId, stories] of featureIdToStories) {
      const adoFeature = workItems.features.find(f => f.id === featureId)!;
      const epicId = adoFeature.parentId ?? -1;
      const list = epicIdToFeatures.get(epicId) ?? [];
      list.push({ feature: adoFeature, stories });
      epicIdToFeatures.set(epicId, list);
    }
    for (const [epicId, featureList] of epicIdToFeatures) {
      const adoEpic = epicId >= 0 ? workItems.epics.find(e => e.id === epicId) : null;
      const epicTitle = adoEpic?.title ?? featureList[0].feature.title;
      const epicDesc = adoEpic ? this.stripHtml(adoEpic.description || '') : this.stripHtml(featureList[0].feature.description || '');
      backlogRequest.epics.push({
        title: epicTitle,
        description: epicDesc,
        azureDevOpsWorkItemId: adoEpic?.id ?? undefined,
        features: featureList.map(({ feature, stories }) => ({
          title: feature.title,
          description: this.stripHtml(feature.description || ''),
          azureDevOpsWorkItemId: feature.id,
          userStories: stories.map(convertStory)
        }))
      });
    }

    // 3c. Truly orphan stories (no epic/feature parent) → Standalone only
    if (orphanStories.length > 0) {
      backlogRequest.epics.push({
        title: STANDALONE_EPIC_TITLE,
        description: 'User stories without epic or feature parent',
        features: [{
          title: 'User Stories',
          description: 'Standalone user stories',
          userStories: orphanStories.map(convertStory)
        }]
      });
    }

    // Merge: use existing epics/features when tree already exists (match by title)
    return this.getBacklog(repositoryId).pipe(
      switchMap(existingEpics => this.mergeBacklogItems(repositoryId, backlogRequest, [...existingEpics], 'AzureDevOps')),
      switchMap(() => this.getBacklog(repositoryId))
    );
  }

  /**
   * Merge backlog items: reuse existing epics/features by title, add stories to them
   * @param source Optional: "Manual" | "AzureDevOps" | "GitHub" - set on all created items
   */
  private mergeBacklogItems(
    repositoryId: string,
    backlogRequest: CreateBacklogRequest,
    existingEpics: Epic[],
    source?: 'Manual' | 'AzureDevOps' | 'GitHub'
  ): Observable<void> {
    const addItems = async () => {
      for (const epicReq of backlogRequest.epics) {
        let epic = this.findEpicByTitle(existingEpics, epicReq.title);
        if (!epic) {
          epic = await firstValueFrom(this.addEpic(repositoryId, epicReq.title, epicReq.description, source, epicReq.azureDevOpsWorkItemId));
          existingEpics.push(epic);
          if (!epic.features) epic.features = [];
        }

        for (const featureReq of epicReq.features) {
          let feature = this.findFeatureByTitle(epic!, featureReq.title);
          if (!feature) {
            feature = await firstValueFrom(
              this.addFeature(epic!.id, featureReq.title, featureReq.description, repositoryId, source, featureReq.azureDevOpsWorkItemId)
            );
            epic!.features = epic!.features ?? [];
            epic!.features.push(feature);
          }

          for (const storyReq of featureReq.userStories) {
            const ac = Array.isArray(storyReq.acceptanceCriteria)
              ? storyReq.acceptanceCriteria.join('\n- ')
              : undefined;
            await firstValueFrom(
              this.addUserStory(
                feature!.id,
                storyReq.title,
                storyReq.description,
                ac,
                storyReq.storyPoints,
                repositoryId,
                source,
                storyReq.azureDevOpsWorkItemId
              )
            );
          }
        }
      }
    };

    return new Observable<void>(subscriber => {
      addItems()
        .then(() => {
          subscriber.next();
          subscriber.complete();
        })
        .catch(err => subscriber.error(err));
    });
  }

  /**
   * Fetch issues from GitHub
   */
  getGitHubIssues(request: GitHubIssuesRequest): Observable<GitHubIssuesHierarchy> {
    return this.apiService.post<GitHubIssuesHierarchy>('/repositories/github/issues', request);
  }

  /**
   * Import GitHub issues into the backlog
   * Milestones become Epics, issues with "feature" label become Features,
   * other issues become User Stories
   */
  importFromGitHub(
    repositoryId: string,
    issues: GitHubIssuesHierarchy,
    selectedMilestoneNumbers: number[],
    includeUnassigned: boolean
  ): Observable<Epic[]> {
    const backlogRequest: CreateBacklogRequest = {
      epics: []
    };

    // Filter to selected milestones
    const selectedMilestones = issues.milestones.filter(m => selectedMilestoneNumbers.includes(m.number));

    for (const milestone of selectedMilestones) {
      // Find issues for this milestone
      const milestoneIssues = issues.issues.filter(i => i.milestoneNumber === milestone.number);
      
      // Separate features (issues with "feature" label) from stories
      const featureIssues = milestoneIssues.filter(i => 
        i.labels.some(l => l.toLowerCase() === 'feature' || l.toLowerCase() === 'enhancement')
      );
      const storyIssues = milestoneIssues.filter(i => 
        !i.labels.some(l => l.toLowerCase() === 'feature' || l.toLowerCase() === 'enhancement')
      );

      const features: { title: string; description: string; userStories: any[] }[] = [];

      // Create features from feature-labeled issues
      for (const featureIssue of featureIssues) {
        features.push({
          title: featureIssue.title,
          description: featureIssue.body || '',
          userStories: [] // Features from GitHub typically don't have child stories
        });
      }

      // Group remaining issues into a "User Stories" feature if there are any
      if (storyIssues.length > 0) {
        features.push({
          title: 'User Stories',
          description: `Issues from milestone "${milestone.title}"`,
          userStories: storyIssues.map(issue => ({
            title: issue.title,
            description: issue.body || '',
            acceptanceCriteria: [],
            storyPoints: undefined
          }))
        });
      }

      if (features.length > 0) {
        backlogRequest.epics.push({
          title: milestone.title,
          description: milestone.description || '',
          features
        });
      }
    }

    // Handle unassigned issues (no milestone)
    if (includeUnassigned && issues.unassignedIssues.length > 0) {
      const unassignedFeatures = issues.unassignedIssues.filter(i =>
        i.labels.some(l => l.toLowerCase() === 'feature' || l.toLowerCase() === 'enhancement')
      );
      const unassignedStories = issues.unassignedIssues.filter(i =>
        !i.labels.some(l => l.toLowerCase() === 'feature' || l.toLowerCase() === 'enhancement')
      );

      const features: { title: string; description: string; userStories: any[] }[] = [];

      for (const featureIssue of unassignedFeatures) {
        features.push({
          title: featureIssue.title,
          description: featureIssue.body || '',
          userStories: []
        });
      }

      if (unassignedStories.length > 0) {
        features.push({
          title: 'Backlog Items',
          description: 'Issues without a milestone',
          userStories: unassignedStories.map(issue => ({
            title: issue.title,
            description: issue.body || '',
            acceptanceCriteria: [],
            storyPoints: undefined
          }))
        });
      }

      if (features.length > 0) {
        backlogRequest.epics.push({
          title: 'Unassigned',
          description: 'Issues not assigned to any milestone',
          features
        });
      }
    }

    // Merge: use existing epics/features when tree already exists (match by title)
    return this.getBacklog(repositoryId).pipe(
      switchMap(existingEpics => this.mergeBacklogItems(repositoryId, backlogRequest, [...existingEpics], 'GitHub')),
      switchMap(() => this.getBacklog(repositoryId))
    );
  }

  /**
   * Strip HTML tags from Azure DevOps descriptions
   */
  private stripHtml(html: string): string {
    if (!html) return '';
    // Simple HTML stripping - convert <br> to newlines, remove other tags
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Parse acceptance criteria from Azure DevOps HTML format
   */
  private parseAcceptanceCriteria(html: string): string[] {
    const text = this.stripHtml(html);
    // Split by newlines and filter empty lines
    return text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }
}

export interface SyncToAzureDevOpsResponse {
  success: boolean;
  syncedCount: number;
  failedCount: number;
  errors: string[];
}

export interface SyncPrStatusResponse {
  success: boolean;
  repositoryId: string;
  updatedCount: number;
  updatedStories: Array<{
    storyId: string;
    storyTitle: string;
    oldStatus: string;
    newStatus: string;
    prMerged: boolean;
    prState: string;
  }>;
}

export interface StoryPrStatusResponse {
  storyId: string;
  hasPr: boolean;
  prUrl?: string;
  prState?: string;
  prMerged?: boolean;
  prMergedAt?: string;
  storyStatus?: string;
  statusUpdated?: boolean;
  error?: string;
}

// Azure DevOps Work Item types
export interface AzureDevOpsWorkItem {
  id: number;
  title: string;
  description?: string;
  workItemType: string;
  state: string;
  assignedTo?: string;
  priority?: number;
  storyPoints?: number;
  acceptanceCriteria?: string;
  parentId?: number;
  areaPath?: string;
  iterationPath?: string;
  childIds: number[];
  url?: string;
  createdDate?: string;
  changedDate?: string;
}

export interface AzureDevOpsWorkItemsHierarchy {
  epics: AzureDevOpsWorkItem[];
  features: AzureDevOpsWorkItem[];
  userStories: AzureDevOpsWorkItem[];
  tasks: AzureDevOpsWorkItem[];
  bugs: AzureDevOpsWorkItem[];
}

export interface AzureDevOpsWorkItemsRequest {
  organizationName: string;
  projectName: string;
  teamId?: string;
  personalAccessToken?: string;
}

export interface AzureDevOpsProject {
  id: string;
  name: string;
  description?: string;
  state: string;
}

export interface AzureDevOpsTeam {
  id: string;
  name: string;
  description?: string;
  projectName?: string;
  projectId?: string;
}

// GitHub Issue types
export interface GitHubIssue {
  number: number;
  title: string;
  body?: string;
  state: string;
  assignee?: string;
  labels: string[];
  milestoneNumber?: number;
  milestoneTitle?: string;
  url: string;
  createdAt: string;
  updatedAt?: string;
  closedAt?: string;
  isPullRequest: boolean;
}

export interface GitHubMilestone {
  number: number;
  title: string;
  description?: string;
  state: string;
  openIssues: number;
  closedIssues: number;
  dueOn?: string;
  createdAt: string;
  url?: string;
}

export interface GitHubIssuesHierarchy {
  milestones: GitHubMilestone[];
  issues: GitHubIssue[];
  unassignedIssues: GitHubIssue[];
}

export interface GitHubIssuesRequest {
  owner: string;
  repo: string;
}
