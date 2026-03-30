import { Injectable, signal } from '@angular/core';
import { Observable, tap, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ApiService } from './api.service';
import { Repository } from '../../shared/models/repository.model';

export interface PagedRepositoriesResult {
  items: Repository[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

export interface SyncSource {
  provider: string;
  isLinked: boolean;
  username: string | null;
}


/** Item returned from GET available/github or available/azure-devops for selective sync */
export interface AvailableRepoItem {
  fullName: string;
  name: string;
  description?: string;
  isPrivate?: boolean;
  defaultBranch?: string;
  alreadyInApp: boolean;
  projectName?: string;
  organizationName?: string;
}

export interface RepositoryTreeItem {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size?: number;
  sha?: string;
  url?: string;
}

export interface RepositoryTree {
  path: string;
  branch: string;
  items: RepositoryTreeItem[];
  readme?: string;
}

export interface RepositoryFileContent {
  name: string;
  path: string;
  content: string;
  encoding: string;
  size: number;
  sha?: string;
  language?: string;
  isBinary: boolean;
  isTruncated: boolean;
}

export interface RepositoryBranch {
  name: string;
  sha: string;
  isDefault: boolean;
  isProtected: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  description?: string;
  state: 'open' | 'closed' | 'merged';
  sourceBranch: string;
  targetBranch: string;
  author: string;
  authorAvatarUrl?: string;
  url: string;
  createdAt: string;
  updatedAt?: string;
  mergedAt?: string;
  closedAt?: string;
  isMerged: boolean;
  isDraft: boolean;
  comments: number;
  commits: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  reviewers: string[];
}

// Code Analysis interfaces
export interface CodeAnalysisResult {
  id: string;
  repositoryId: string;
  branch: string;
  summary: string;
  architecture?: string;
  keyComponents?: string;
  dependencies?: string;
  recommendations?: string;
  analyzedAt: string;
  model?: string;
}

export interface FileAnalysisResult {
  id: string;
  repositoryId: string;
  filePath: string;
  branch: string;
  explanation: string;
  keyFunctions?: string;
  complexity?: string;
  suggestions?: string;
  analyzedAt: string;
  model?: string;
}

export const DEFAULT_AGENT_RULES = `# DevPilot AI Agent Instructions

## Before Making Changes
1. Explore the project structure and identify the tech stack
2. Read README.md if it exists
3. Find and run the existing build command (e.g. dotnet build, npm run build, mvn compile, go build)
4. Find and run existing tests (e.g. dotnet test, npm test, pytest, go test)
5. Note any failing tests or build errors before your changes

## After Making Changes
1. Build the project again and fix any compilation errors
2. Run all tests and fix any regressions you introduced
3. Explain what you changed and why

## Guidelines
- Follow the existing code style and conventions
- Prioritize security and performance
- Be concise and actionable in your suggestions
- Explain your reasoning when making suggestions`;

/**
 * Service for managing repositories
 * Uses signals for reactive state management
 */
@Injectable({
  providedIn: 'root'
})
export class RepositoryService {
  private readonly repositoriesSignal = signal<Repository[]>([]);
  private readonly syncSourcesSignal = signal<SyncSource[]>([]);
  private readonly syncingSignal = signal<string | null>(null);
  
  // Expose readonly signals
  readonly repositories = this.repositoriesSignal.asReadonly();
  readonly syncSources = this.syncSourcesSignal.asReadonly();
  readonly syncing = this.syncingSignal.asReadonly();

  constructor(private apiService: ApiService) {}

  /**
   * Fetch all repositories for the current user (no pagination).
   * @param filter Optional: 'all' | 'mine' | 'shared'
   */
  getRepositories(filter?: 'all' | 'mine' | 'shared'): Observable<Repository[]> {
    const qs = filter && filter !== 'all' ? `?filter=${encodeURIComponent(filter)}` : '';
    return this.apiService.get<Repository[]>(`/repositories${qs}`).pipe(
      tap(repositories => this.repositoriesSignal.set(repositories))
    );
  }

  /**
   * Fetch repositories with pagination and search
   */
  getRepositoriesPaginated(params: {
    search?: string;
    filter?: 'all' | 'mine' | 'shared';
    page?: number;
    pageSize?: number;
  } = {}): Observable<PagedRepositoriesResult> {
    const qs = new URLSearchParams();
    if (params.search?.trim()) qs.set('search', params.search.trim());
    if (params.filter && params.filter !== 'all') qs.set('filter', params.filter);
    if (params.page != null) qs.set('page', String(params.page));
    if (params.pageSize != null) qs.set('pageSize', String(params.pageSize));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.apiService.get<PagedRepositoriesResult>(`/repositories${query}`);
  }

  /**
   * Get available sync sources (which providers are linked)
   */
  getSyncSources(): Observable<SyncSource[]> {
    return this.apiService.get<SyncSource[]>('/repositories/sync/sources').pipe(
      tap(sources => this.syncSourcesSignal.set(sources))
    );
  }

  /**
   * Add a GitHub repository manually by URL (e.g. https://github.com/owner/repo or owner/repo)
   * Requires GitHub to be connected.
   */
  addManualGitHubRepo(repoUrl: string): Observable<{ id: string; name: string; fullName: string; provider: string; organizationName: string; defaultBranch?: string; alreadyExists: boolean }> {
    return this.apiService.post<{ id: string; name: string; fullName: string; provider: string; organizationName: string; defaultBranch?: string; alreadyExists: boolean }>(
      '/repositories/add-github',
      { repoUrl }
    );
  }

  /**
   * Sync repositories from GitHub
   * Uses authenticated user's GitHub token
   */
  syncFromGitHub(): Observable<Repository[]> {
    this.syncingSignal.set('GitHub');
    return this.apiService.post<Repository[]>('/repositories/sync/github', null).pipe(
      tap(repositories => {
        // Merge with existing repositories
        const existing = this.repositoriesSignal();
        const merged = this.mergeRepositories(existing, repositories);
        this.repositoriesSignal.set(merged);
        this.syncingSignal.set(null);
      }),
      catchError(err => {
        this.syncingSignal.set(null);
        throw err;
      })
    );
  }

  /**
   * Sync repositories from Azure DevOps
   * Uses authenticated user's Azure DevOps token or a Personal Access Token stored in settings
   * @param organizationName Optional: Azure DevOps organization name (e.g., 'myorg' from dev.azure.com/myorg)
   */
  syncFromAzureDevOps(organizationName?: string): Observable<Repository[]> {
    this.syncingSignal.set('AzureDevOps');
    
    const body: any = {};
    if (organizationName) body.organizationName = organizationName;
    
    return this.apiService.post<Repository[]>('/repositories/sync/azure-devops', Object.keys(body).length > 0 ? body : null).pipe(
      tap(repositories => {
        // Handle response that may include a message instead of direct array
        const repos = Array.isArray(repositories) ? repositories : (repositories as any).repositories || [];
        // Merge with existing repositories
        const existing = this.repositoriesSignal();
        const merged = this.mergeRepositories(existing, repos);
        this.repositoriesSignal.set(merged);
        this.syncingSignal.set(null);
      }),
      catchError(err => {
        this.syncingSignal.set(null);
        throw err;
      })
    );
  }

  /**
   * Sync from all linked providers
   */
  syncFromAllProviders(): Observable<Repository[][]> {
    const sources = this.syncSourcesSignal();
    const syncObservables: Observable<Repository[]>[] = [];

    if (sources.find(s => s.provider === 'GitHub' && s.isLinked)) {
      syncObservables.push(
        this.apiService.post<Repository[]>('/repositories/sync/github', null).pipe(
          catchError(() => of([]))
        )
      );
    }

    if (sources.find(s => s.provider === 'AzureDevOps' && s.isLinked)) {
      syncObservables.push(
        this.apiService.post<Repository[]>('/repositories/sync/azure-devops', null).pipe(
          catchError(() => of([]))
        )
      );
    }

    if (syncObservables.length === 0) {
      return of([]);
    }

    this.syncingSignal.set('all');
    return forkJoin(syncObservables).pipe(
      tap(results => {
        const allRepos = results.flat();
        const existing = this.repositoriesSignal();
        const merged = this.mergeRepositories(existing, allRepos);
        this.repositoriesSignal.set(merged);
        this.syncingSignal.set(null);
      }),
      catchError(err => {
        this.syncingSignal.set(null);
        throw err;
      })
    );
  }

  /**
   * Create a pull request for a repository
   * @param workItemIds Azure DevOps work item IDs to link to the PR (e.g. [190])
   */
  createPullRequest(
    repositoryId: string,
    params: { headBranch: string; baseBranch: string; title: string; body?: string; workItemIds?: number[] }
  ): Observable<{ url: string; number: number; title: string }> {
    return this.apiService.post<{ url: string; number: number; title: string }>(
      `/repositories/${repositoryId}/pull-requests`,
      params
    );
  }

  /**
   * Check if a specific provider is linked
   */
  isProviderLinked(provider: string): boolean {
    const sources = this.syncSourcesSignal();
    return sources.some(s => s.provider === provider && s.isLinked);
  }

  /**
   * Merge new repositories with existing ones (avoid duplicates by ID)
   */
  private mergeRepositories(existing: Repository[], newRepos: Repository[]): Repository[] {
    const existingIds = new Set(existing.map(r => r.id));
    const uniqueNew = newRepos.filter(r => !existingIds.has(r.id));
    return [...existing, ...uniqueNew];
  }

  /**
   * Get repository file tree (directory listing)
   */
  getRepositoryTree(repositoryId: string, path?: string, branch?: string): Observable<RepositoryTree> {
    let url = `/repositories/${repositoryId}/tree`;
    const params: string[] = [];
    if (path) params.push(`path=${encodeURIComponent(path)}`);
    if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
    if (params.length > 0) url += '?' + params.join('&');
    
    return this.apiService.get<RepositoryTree>(url);
  }

  /**
   * Get file content from repository
   */
  getFileContent(repositoryId: string, path: string, branch?: string): Observable<RepositoryFileContent> {
    let url = `/repositories/${repositoryId}/file?path=${encodeURIComponent(path)}`;
    if (branch) url += `&branch=${encodeURIComponent(branch)}`;
    
    return this.apiService.get<RepositoryFileContent>(url);
  }

  /**
   * Get repository branches
   */
  getBranches(repositoryId: string): Observable<RepositoryBranch[]> {
    return this.apiService.get<RepositoryBranch[]>(`/repositories/${repositoryId}/branches`);
  }

  /**
   * Get a repository by ID
   */
  getRepositoryById(repositoryId: string): Repository | undefined {
    const id = String(repositoryId);
    return this.repositoriesSignal().find(r => String(r.id) === id);
  }

  /**
   * Delete a repository and its backlog. Analysis data is cascade-deleted.
   */
  deleteRepository(repositoryId: string): Observable<{ message: string }> {
    return this.apiService.delete<{ message: string }>(`/repositories/${repositoryId}`).pipe(
      tap(() => {
        this.repositoriesSignal.update(repos => repos.filter(r => String(r.id) !== String(repositoryId)));
      })
    );
  }

  /**
   * Set the LLM configuration for a repository. Pass null to use the user's default LLM.
   */
  updateRepositoryLlmSetting(repositoryId: string, llmSettingId: string | null): Observable<Repository> {
    return this.apiService.patch<Repository>(`/repositories/${repositoryId}/llm-setting`, { llmSettingId }).pipe(
      tap(updated => {
        this.repositoriesSignal.update(repos =>
          repos.map(r => (String(r.id) === String(repositoryId) ? { ...r, ...updated } : r))
        );
      })
    );
  }

  /**
   * Update the AI agent rules for a repository. Pass null to reset to default.
   */
  updateRepositoryAgentRules(repositoryId: string, agentRules: string | null): Observable<any> {
    return this.apiService.patch<any>(`/repositories/${repositoryId}/agent-rules`, { agentRules }).pipe(
      tap(() => {
        this.repositoriesSignal.update(repos =>
          repos.map(r => (String(r.id) === String(repositoryId) ? { ...r, agentRules } : r))
        );
      })
    );
  }

  /**
   * Get the AI agent rules for a repository.
   */
  getRepositoryAgentRules(repositoryId: string): Observable<{ agentRules: string | null; isDefault: boolean }> {
    return this.apiService.get<{ agentRules: string | null; isDefault: boolean }>(`/repositories/${repositoryId}/agent-rules`);
  }

  /**
   * Get list of repositories available from GitHub (for selective sync).
   */
  getAvailableGitHubRepositories(): Observable<AvailableRepoItem[]> {
    return this.apiService.get<AvailableRepoItem[]>('/repositories/available/github');
  }

  /**
   * Get list of repositories available from Azure DevOps (for selective sync).
   * @param organization Optional organization name (e.g. 'myorg' from dev.azure.com/myorg)
   */
  getAvailableAzureDevOpsRepositories(organization?: string): Observable<AvailableRepoItem[]> {
    const qs = organization?.trim() ? `?organization=${encodeURIComponent(organization.trim())}` : '';
    return this.apiService.get<AvailableRepoItem[]>(`/repositories/available/azure-devops${qs}`);
  }

  /**
   * Sync only selected GitHub repositories into the app.
   */
  syncSelectedGitHubRepositories(fullNames: string[]): Observable<{ added: number; repositories: Repository[] }> {
    return this.apiService.post<{ added: number; repositories: Repository[] }>('/repositories/sync/github/selected', { fullNames }).pipe(
      tap(res => {
        if (res.repositories?.length) {
          const existing = this.repositoriesSignal();
          const merged = this.mergeRepositories(existing, res.repositories);
          this.repositoriesSignal.set(merged);
        }
        this.syncingSignal.set(null);
      }),
      catchError(err => {
        this.syncingSignal.set(null);
        throw err;
      })
    );
  }

  /**
   * Sync only selected Azure DevOps repositories into the app.
   */
  syncSelectedAzureDevOpsRepositories(organization: string, fullNames: string[]): Observable<{ added: number; repositories: Repository[] }> {
    return this.apiService.post<{ added: number; repositories: Repository[] }>('/repositories/sync/azure-devops/selected', { organization: organization.trim(), fullNames }).pipe(
      tap(res => {
        if (res.repositories?.length) {
          const existing = this.repositoriesSignal();
          const merged = this.mergeRepositories(existing, res.repositories);
          this.repositoriesSignal.set(merged);
        }
        this.syncingSignal.set(null);
      }),
      catchError(err => {
        this.syncingSignal.set(null);
        throw err;
      })
    );
  }

  /**
   * Get pull requests for a repository
   */
  getPullRequests(repositoryId: string, state?: 'open' | 'closed' | 'all'): Observable<PullRequest[]> {
    let url = `/repositories/${repositoryId}/pull-requests`;
    if (state) url += `?state=${state}`;
    return this.apiService.get<PullRequest[]>(url);
  }

  /**
   * Get authenticated clone URL (with PAT embedded for private repos).
   * For GitHub repos also returns archiveUrl (zipball) so sandbox can download code without git clone when clone is blocked.
   */
  getAuthenticatedCloneUrl(repositoryId: string): Observable<{ cloneUrl: string; archiveUrl?: string }> {
    return this.apiService.get<{ cloneUrl: string; archiveUrl?: string }>(`/repositories/${repositoryId}/clone-url`);
  }

  /**
   * List users a repository is shared with (owner only).
   */
  getSharedWith(repositoryId: string): Observable<{ sharedWith: { userId: string; email: string; name?: string }[] }> {
    return this.apiService.get<{ sharedWith: { userId: string; email: string; name?: string }[] }>(
      `/repositories/${repositoryId}/shared-with`
    );
  }

  /**
   * Share repository with another user by email (owner only).
   */
  shareRepository(repositoryId: string, email: string): Observable<{ message: string; sharedWithUserId?: string }> {
    return this.apiService.post<{ message: string; sharedWithUserId?: string }>(
      `/repositories/${repositoryId}/share`,
      { email: email.trim() }
    );
  }

  /**
   * Remove access for a user (owner only).
   */
  unshareRepository(repositoryId: string, sharedWithUserId: string): Observable<{ message: string }> {
    return this.apiService.delete<{ message: string }>(
      `/repositories/${repositoryId}/share/${sharedWithUserId}`
    );
  }

  /**
   * Suggest users by email or name (for share dialog).
   */
  suggestUsers(query: string, limit = 10): Observable<{ userId: string; email: string; name?: string }[]> {
    if (!query?.trim()) return of([]);
    const params = new URLSearchParams({ q: query.trim(), limit: String(Math.min(limit, 20)) });
    return this.apiService.get<{ userId: string; email: string; name?: string }[]>(
      `/users/suggest?${params.toString()}`
    );
  }

  // ============================================
  // Code Analysis Methods
  // ============================================

  /**
   * Get stored code analysis for a repository
   */
  getCodeAnalysis(repositoryId: string, branch?: string): Observable<CodeAnalysisResult> {
    let url = `/repositories/${repositoryId}/analysis`;
    if (branch) url += `?branch=${encodeURIComponent(branch)}`;
    return this.apiService.get<CodeAnalysisResult>(url);
  }

  /**
   * Save code analysis results (frontend-driven sandbox flow)
   */
  saveCodeAnalysis(
    repositoryId: string, 
    analysis: {
      branch?: string;
      summary: string;
      architecture?: string;
      keyComponents?: string;
      dependencies?: string;
      recommendations?: string;
      model?: string;
    }
  ): Observable<CodeAnalysisResult> {
    return this.apiService.post<CodeAnalysisResult>(
      `/repositories/${repositoryId}/analysis`,
      analysis
    );
  }

  /**
   * Get stored file analysis
   */
  getFileAnalysis(repositoryId: string, filePath: string, branch?: string): Observable<FileAnalysisResult> {
    let url = `/repositories/${repositoryId}/analysis/file?path=${encodeURIComponent(filePath)}`;
    if (branch) url += `&branch=${encodeURIComponent(branch)}`;
    return this.apiService.get<FileAnalysisResult>(url);
  }

  /**
   * Trigger a new file analysis
   * Uses direct AI chat completion (no sandbox needed)
   */
  analyzeFile(repositoryId: string, filePath: string, fileContent: string, branch?: string): Observable<FileAnalysisResult> {
    return this.apiService.post<FileAnalysisResult>(
      `/repositories/${repositoryId}/analysis/file`,
      { filePath, fileContent, branch }
    );
  }

  /**
   * Delete all stored analysis for a repository (for refresh)
   */
  deleteAnalysis(repositoryId: string): Observable<{ message: string }> {
    return this.apiService.delete<{ message: string }>(`/repositories/${repositoryId}/analysis`);
  }
}
