import { Injectable, Inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { APP_CONFIG, AppConfig } from './config.service';
import { AuthService } from './auth.service';

export interface Sandbox {
  id: string;
  status: string;
  vnc_password?: string;
}

export interface CreateSandboxResponse {
  id: string;
  status: string;
  vnc_password?: string;
}

/** Active Ask sandbox for a repository (server-side binding; survives page refresh). */
export interface SandboxForRepositoryResponse {
  id: string;
  status: string;
  repo_branch: string;
  vnc_password?: string | null;
}

/**
 * Sandbox creation request.
 * AI config, MCP servers, and Zed settings are resolved server-side —
 * the frontend never sends API keys or MCP secrets.
 */
export interface CreateSandboxRequest {
  resolution?: string;
  repo_url?: string;
  repo_name?: string;
  /** DevPilot repository UUID; server uses this to persist Ask sandbox binding (refresh reconnect). */
  repository_id?: string;
  repo_branch?: string;
  /** GitHub zipball URL (e.g. api.github.com/.../zipball/main) to download code without git clone when clone is blocked */
  repo_archive_url?: string;
  github_token?: string;
  azure_devops_pat?: string;
  artifact_feeds?: { name: string; organization: string; feedName: string; projectName?: string; feedType: string }[];
  /** Optional override; prefer passing story_id so rules resolve server-side. */
  agent_rules?: string;
  /** When set with repo_name, agent rules resolve from this story's profile or repository default. */
  story_id?: string;
}

/**
 * Service for managing isolated sandbox containers
 * Each sandbox is an independent Docker container with its own desktop environment
 */
@Injectable({
  providedIn: 'root'
})
export class SandboxService {
  private apiUrl: string;
  private currentSandboxSubject = new BehaviorSubject<Sandbox | null>(null);

  currentSandbox$ = this.currentSandboxSubject.asObservable();

  constructor(
    private http: HttpClient,
    @Inject(APP_CONFIG) config: AppConfig,
    private authService: AuthService
  ) {
    this.apiUrl = `${config.apiUrl}/sandboxes`;
  }

  /**
   * Create a new isolated sandbox container
   * @param options Sandbox configuration including repo and AI settings
   */
  createSandbox(options: CreateSandboxRequest = {}): Observable<CreateSandboxResponse> {
    const request: CreateSandboxRequest = {
      resolution: options.resolution || '1920x1080x24',
      ...options
    };

    console.log('Creating sandbox with options:', request);

    return this.http.post<CreateSandboxResponse>(this.apiUrl, request).pipe(
      tap(sandbox => {
        this.currentSandboxSubject.next({
          id: sandbox.id,
          status: sandbox.status,
          vnc_password: sandbox.vnc_password,
        });
      }),
      catchError(error => {
        console.error('Failed to create sandbox:', error);
        throw error;
      })
    );
  }

  /**
   * Get all active sandboxes
   */
  listSandboxes(): Observable<Sandbox[]> {
    return this.http.get<{ sandboxes: Sandbox[] }>(this.apiUrl).pipe(
      map(response => response.sandboxes),
      catchError(error => {
        console.error('Failed to list sandboxes:', error);
        return of([]);
      })
    );
  }

  /**
   * Returns the sandbox bound to this repository for the current user (Code Ask), if still running.
   */
  getSandboxForRepository(repositoryId: string): Observable<SandboxForRepositoryResponse | null> {
    return this.http.get<SandboxForRepositoryResponse>(`${this.apiUrl}/for-repository/${repositoryId}`).pipe(
      catchError(() => of(null))
    );
  }

  /**
   * Get a specific sandbox's status
   */
  getSandbox(sandboxId: string): Observable<Sandbox | null> {
    return this.http.get<Sandbox>(`${this.apiUrl}/${sandboxId}`).pipe(
      catchError(error => {
        console.error('Failed to get sandbox:', error);
        return of(null);
      })
    );
  }

  /**
   * Stop and remove a sandbox
   */
  /**
   * Fire-and-forget DELETE when the document is unloading (refresh/close tab).
   * Uses fetch + keepalive so the request may still reach the server after navigation starts.
   */
  requestDeleteSandboxOnUnload(sandboxId: string): void {
    const token = this.authService.getToken();
    const url = `${this.apiUrl}/${encodeURIComponent(sandboxId)}`;
    try {
      void fetch(url, {
        method: 'DELETE',
        keepalive: true,
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  deleteSandbox(sandboxId: string): Observable<boolean> {
    return this.http.delete<{ status: string }>(`${this.apiUrl}/${sandboxId}`).pipe(
      tap(() => {
        if (this.currentSandboxSubject.value?.id === sandboxId) {
          this.currentSandboxSubject.next(null);
        }
      }),
      map(() => true),
      catchError(error => {
        console.error('Failed to delete sandbox:', error);
        return of(false);
      })
    );
  }

  /**
   * Stop a sandbox (but keep container for later restart)
   */
  stopSandbox(sandboxId: string): Observable<boolean> {
    return this.http.post<{ status: string }>(`${this.apiUrl}/${sandboxId}/stop`, {}).pipe(
      map(() => true),
      catchError(error => {
        console.error('Failed to stop sandbox:', error);
        return of(false);
      })
    );
  }

  /**
   * Check if sandbox API is available
   */
  checkHealth(): Observable<boolean> {
    return this.http.get<{ status: string }>(this.apiUrl).pipe(
      map(() => true),
      catchError(() => of(false))
    );
  }

  /**
   * Get current sandbox
   */
  get currentSandbox(): Sandbox | null {
    return this.currentSandboxSubject.value;
  }

  /**
   * Clear current sandbox reference
   */
  clearCurrentSandbox(): void {
    this.currentSandboxSubject.next(null);
  }
}
