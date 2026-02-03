import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { RepositoryService } from '../../services/repository.service';
import { switchMap, catchError } from 'rxjs/operators';
import { of } from 'rxjs';

/**
 * OAuth2 callback component to handle GitHub and Microsoft OAuth redirects
 * Supports both login and provider linking flows
 */
@Component({
  selector: 'app-callback',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="callback-container">
      <div class="callback-card">
        @if (loading()) {
          <div class="spinner"></div>
          <h2>{{ statusMessage() }}</h2>
          <p class="subtitle">Please wait...</p>
        } @else if (error()) {
          <div class="error-icon">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 8V12M12 16H12.01M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <h2>Authentication failed</h2>
          <p class="error-message">{{ error() }}</p>
          <button (click)="goToLogin()" class="back-button">Back to Login</button>
        } @else {
          <div class="success-icon">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 12L11 14L15 10M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <h2>Login successful!</h2>
          <p class="subtitle">Redirecting...</p>
        }
      </div>
    </div>
  `,
  styles: [`
    .callback-container {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--surface-ground);
      padding: 2rem;
    }
    .callback-card {
      background: var(--surface-card);
      border: 1px solid var(--border-default);
      border-radius: 16px;
      padding: 3rem;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    h2 {
      margin: 0 0 0.5rem 0;
      color: var(--text-primary);
      font-size: 1.5rem;
      font-weight: 600;
    }
    .subtitle {
      color: var(--text-secondary);
      margin: 0;
    }
    .spinner {
      width: 48px;
      height: 48px;
      border: 4px solid var(--border-light);
      border-top-color: var(--brand-primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 1.5rem;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .error-icon, .success-icon {
      width: 56px;
      height: 56px;
      margin: 0 auto 1rem;
    }
    .error-icon svg {
      width: 100%;
      height: 100%;
      color: #ef4444;
    }
    .success-icon svg {
      width: 100%;
      height: 100%;
      color: #10b981;
    }
    .error-message {
      color: #ef4444;
      margin: 1rem 0;
      font-size: 0.875rem;
    }
    .back-button {
      margin-top: 1.5rem;
      padding: 0.75rem 1.5rem;
      background: linear-gradient(135deg, var(--brand-primary) 0%, #4f46e5 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .back-button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
    }
  `]
})
export class CallbackComponent implements OnInit {
  loading = signal<boolean>(true);
  error = signal<string | null>(null);
  statusMessage = signal<string>('Completing login...');

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private authService: AuthService,
    private repositoryService: RepositoryService
  ) {}

  ngOnInit(): void {
    // Determine provider from route
    const routeUrl = this.router.url;
    const isMicrosoft = routeUrl.includes('/callback/microsoft');
    const isAzureDevOps = routeUrl.includes('/callback/azure-devops');
    const isLinking = routeUrl.includes('state=link');

    // Get authorization code from query params
    this.route.queryParams.subscribe(params => {
      const code = params['code'];
      const error = params['error'];
      const state = params['state'];

      if (error) {
        const provider = isMicrosoft ? 'Microsoft' : isAzureDevOps ? 'Azure DevOps' : 'GitHub';
        this.error.set(`${provider} authorization failed: ${error}`);
        this.loading.set(false);
        return;
      }

      if (!code) {
        this.error.set('Authorization code not found');
        this.loading.set(false);
        return;
      }

      // Azure DevOps is always a linking flow (not used for login)
      if (isAzureDevOps) {
        this.handleLinkingFlow(code, false, true);
        return;
      }

      // Handle linking flow (when already logged in)
      if (state === 'link' || isLinking) {
        this.handleLinkingFlow(code, isMicrosoft, false);
        return;
      }

      // Handle login flow
      if (isMicrosoft) {
        this.handleMicrosoftLogin(code);
      } else {
        this.handleGitHubLogin(code);
      }
    });
  }

  private handleGitHubLogin(code: string): void {
    this.statusMessage.set('Completing GitHub login...');
    
    this.authService.handleGitHubCallback(code).pipe(
      switchMap(() => {
        this.statusMessage.set('Syncing your repositories...');
        return this.repositoryService.syncFromGitHub().pipe(
          catchError(err => {
            console.warn('Auto-sync failed, but login succeeded:', err);
            return of([]);
          })
        );
      })
    ).subscribe({
      next: () => {
        this.router.navigate(['/repositories']);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to complete authentication');
        this.loading.set(false);
      }
    });
  }

  private handleMicrosoftLogin(code: string): void {
    this.statusMessage.set('Completing Microsoft login...');
    
    this.authService.handleMicrosoftCallback(code).subscribe({
      next: () => {
        this.router.navigate(['/repositories']);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to complete Microsoft authentication');
        this.loading.set(false);
      }
    });
  }

  private handleLinkingFlow(code: string, isMicrosoft: boolean, isAzureDevOps: boolean): void {
    if (isAzureDevOps) {
      this.statusMessage.set('Linking Azure DevOps account...');
      this.authService.linkAzureDevOps(code).subscribe({
        next: () => {
          this.router.navigate(['/settings'], { queryParams: { linked: 'azure-devops' } });
        },
        error: (err) => {
          this.error.set(err.error?.message || err.message || 'Failed to link Azure DevOps account');
          this.loading.set(false);
        }
      });
    } else {
      this.statusMessage.set('Linking GitHub account...');
      this.authService.linkGitHub(code).subscribe({
        next: () => {
          this.router.navigate(['/settings'], { queryParams: { linked: 'github' } });
        },
        error: (err) => {
          this.error.set(err.error?.message || err.message || 'Failed to link GitHub account');
          this.loading.set(false);
        }
      });
    }
  }

  goToLogin(): void {
    this.router.navigate(['/login']);
  }
}
