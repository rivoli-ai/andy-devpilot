import { Injectable, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService } from './api.service';
import { Epic } from '../../shared/models/epic.model';
import { Feature } from '../../shared/models/feature.model';
import { UserStory } from '../../shared/models/user-story.model';

export interface CreateBacklogRequest {
  epics: {
    title: string;
    description: string;
    features: {
      title: string;
      description: string;
      userStories: {
        title: string;
        description: string;
        acceptanceCriteria: string[];
        storyPoints?: number;
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
   * Sync PR statuses for all stories with PRs in a repository
   * Checks GitHub for PR status and updates story status accordingly:
   * - PR open -> PendingReview
   * - PR merged -> Done
   */
  syncPrStatuses(repositoryId: string, accessToken: string): Observable<SyncPrStatusResponse> {
    return this.apiService.post<SyncPrStatusResponse>(
      `/backlog/repository/${repositoryId}/sync-pr-status`,
      { accessToken }
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
   */
  addEpic(repositoryId: string, title: string, description?: string): Observable<Epic> {
    return this.apiService.post<Epic>(`/backlog/repository/${repositoryId}/epic`, { title, description }).pipe(
      tap(() => this.getBacklog(repositoryId).subscribe())
    );
  }

  /**
   * Add a new Feature to an Epic
   */
  addFeature(epicId: string, title: string, description?: string, repositoryId?: string): Observable<Feature> {
    return this.apiService.post<Feature>(`/backlog/epic/${epicId}/feature`, { title, description }).pipe(
      tap(() => repositoryId && this.getBacklog(repositoryId).subscribe())
    );
  }

  /**
   * Add a new User Story to a Feature
   */
  addUserStory(
    featureId: string,
    title: string,
    description?: string,
    acceptanceCriteria?: string,
    storyPoints?: number,
    repositoryId?: string
  ): Observable<UserStory> {
    return this.apiService.post<UserStory>(`/backlog/feature/${featureId}/story`, {
      title,
      description,
      acceptanceCriteria,
      storyPoints
    }).pipe(
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
   * Fetch work items from Azure DevOps
   */
  getAzureDevOpsWorkItems(request: AzureDevOpsWorkItemsRequest): Observable<AzureDevOpsWorkItemsHierarchy> {
    return this.apiService.post<AzureDevOpsWorkItemsHierarchy>('/repositories/azure-devops/work-items', request);
  }

  /**
   * Import Azure DevOps work items into the backlog
   * Converts Azure DevOps Epics/Features/User Stories to DevPilot format
   */
  importFromAzureDevOps(
    repositoryId: string,
    workItems: AzureDevOpsWorkItemsHierarchy,
    selectedEpicIds: number[]
  ): Observable<Epic[]> {
    // Build the backlog structure from selected Azure DevOps items
    const backlogRequest: CreateBacklogRequest = {
      epics: []
    };

    // Filter to only selected epics and their children
    const selectedEpics = workItems.epics.filter(e => selectedEpicIds.includes(e.id));

    for (const adoEpic of selectedEpics) {
      // Find features that belong to this epic
      const epicFeatures = workItems.features.filter(f => f.parentId === adoEpic.id);

      const features = epicFeatures.map(adoFeature => {
        // Find user stories that belong to this feature
        const featureStories = workItems.userStories.filter(s => s.parentId === adoFeature.id);

        return {
          title: adoFeature.title,
          description: this.stripHtml(adoFeature.description || ''),
          userStories: featureStories.map(adoStory => ({
            title: adoStory.title,
            description: this.stripHtml(adoStory.description || ''),
            acceptanceCriteria: adoStory.acceptanceCriteria 
              ? this.parseAcceptanceCriteria(adoStory.acceptanceCriteria)
              : [],
            storyPoints: adoStory.storyPoints
          }))
        };
      });

      // Also add orphan user stories (stories without a feature parent but with this epic as ancestor)
      // These are stories directly under the epic
      const orphanStories = workItems.userStories.filter(s => s.parentId === adoEpic.id);
      if (orphanStories.length > 0) {
        // Create a "General" feature for orphan stories
        features.push({
          title: 'General',
          description: 'User stories imported directly from epic',
          userStories: orphanStories.map(adoStory => ({
            title: adoStory.title,
            description: this.stripHtml(adoStory.description || ''),
            acceptanceCriteria: adoStory.acceptanceCriteria 
              ? this.parseAcceptanceCriteria(adoStory.acceptanceCriteria)
              : [],
            storyPoints: adoStory.storyPoints
          }))
        });
      }

      backlogRequest.epics.push({
        title: adoEpic.title,
        description: this.stripHtml(adoEpic.description || ''),
        features
      });
    }

    return this.createBacklog(repositoryId, backlogRequest);
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

    return this.createBacklog(repositoryId, backlogRequest);
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
  personalAccessToken?: string;
}

export interface AzureDevOpsProject {
  id: string;
  name: string;
  description?: string;
  state: string;
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
