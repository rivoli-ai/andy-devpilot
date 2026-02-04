import { Injectable, signal } from '@angular/core';
import { Observable, tap, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ApiService } from './api.service';
import { Repository } from '../../shared/models/repository.model';

export interface SyncSource {
  provider: string;
  isLinked: boolean;
  username: string | null;
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
   * Fetch all repositories for the current user
   */
  getRepositories(): Observable<Repository[]> {
    return this.apiService.get<Repository[]>('/repositories').pipe(
      tap(repositories => this.repositoriesSignal.set(repositories))
    );
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
   */
  createPullRequest(
    repositoryId: string,
    params: { headBranch: string; baseBranch: string; title: string; body?: string }
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
    return this.repositoriesSignal().find(r => r.id === repositoryId);
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
   * Get authenticated clone URL (with PAT embedded for private repos)
   */
  getAuthenticatedCloneUrl(repositoryId: string): Observable<{ cloneUrl: string }> {
    return this.apiService.get<{ cloneUrl: string }>(`/repositories/${repositoryId}/clone-url`);
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
