import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { getSandboxApiUrl, getVncHtmlUrl } from '../config/vps.config';

export interface Sandbox {
  id: string;
  port: number;
  bridge_port?: number;
  status: string;
  url?: string;
  bridge_url?: string;
  created_at?: number;
}

export interface CreateSandboxResponse {
  id: string;
  port: number;
  bridge_port?: number;
  url: string;
  bridge_url?: string;
  status: string;
}

export interface CreateSandboxRequest {
  resolution?: string;
  repo_url?: string;
  repo_name?: string;
  repo_branch?: string;
  github_token?: string; // For cloning private GitHub repos
  azure_devops_pat?: string; // For cloning Azure DevOps repos
  ai_config?: {
    provider: string;
    api_key?: string;
    model: string;
    base_url?: string;
  };
  zed_settings?: object;
}

/**
 * Service for managing isolated sandbox containers
 * Each sandbox is an independent Docker container with its own desktop environment
 */
@Injectable({
  providedIn: 'root'
})
export class SandboxService {
  private apiUrl = getSandboxApiUrl();
  private currentSandboxSubject = new BehaviorSubject<Sandbox | null>(null);
  
  currentSandbox$ = this.currentSandboxSubject.asObservable();
  
  constructor(private http: HttpClient) {}

  /**
   * Create a new isolated sandbox container
   * @param options Sandbox configuration including repo and AI settings
   */
  createSandbox(options: CreateSandboxRequest = {}): Observable<CreateSandboxResponse> {
    const request: CreateSandboxRequest = {
      resolution: options.resolution || '1920x1080x24',
      ...options
    };

    console.log('Creating sandbox with options:', {
      ...request,
      ai_config: request.ai_config ? { ...request.ai_config, api_key: '***' } : undefined
    });

    return this.http.post<CreateSandboxResponse>(`${this.apiUrl}/sandboxes`, request).pipe(
      tap(sandbox => {
        // Update the URL with the actual VPS IP
        sandbox.url = getVncHtmlUrl(sandbox.port);
        this.currentSandboxSubject.next({
          id: sandbox.id,
          port: sandbox.port,
          bridge_port: sandbox.bridge_port,
          status: sandbox.status,
          url: sandbox.url,
          bridge_url: sandbox.bridge_url
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
    return this.http.get<{ sandboxes: Sandbox[] }>(`${this.apiUrl}/sandboxes`).pipe(
      map(response => response.sandboxes),
      catchError(error => {
        console.error('Failed to list sandboxes:', error);
        return of([]);
      })
    );
  }

  /**
   * Get a specific sandbox's status
   */
  getSandbox(sandboxId: string): Observable<Sandbox | null> {
    return this.http.get<Sandbox>(`${this.apiUrl}/sandboxes/${sandboxId}`).pipe(
      catchError(error => {
        console.error('Failed to get sandbox:', error);
        return of(null);
      })
    );
  }

  /**
   * Stop and remove a sandbox
   */
  deleteSandbox(sandboxId: string): Observable<boolean> {
    return this.http.delete<{ status: string }>(`${this.apiUrl}/sandboxes/${sandboxId}`).pipe(
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
    return this.http.post<{ status: string }>(`${this.apiUrl}/sandboxes/${sandboxId}/stop`, {}).pipe(
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
    return this.http.get<{ status: string }>(`${this.apiUrl}/health`).pipe(
      map(response => response.status === 'ok'),
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
