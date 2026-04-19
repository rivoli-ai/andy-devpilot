import { Component, OnInit, OnDestroy, signal, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, firstValueFrom, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { SandboxBridgeService } from '../../core/services/sandbox-bridge.service';
import { SandboxService, CreateSandboxResponse } from '../../core/services/sandbox.service';
import { BacklogService } from '../../core/services/backlog.service';
import { RepositoryService } from '../../core/services/repository.service';
import { ArtifactFeedService } from '../../core/services/artifact-feed.service';
import { Repository } from '../../shared/models/repository.model';
import { VPS_CONFIG } from '../../core/config/vps.config';
import { ButtonComponent } from '../../shared/components';

interface GeneratedBacklog {
  epics: GeneratedEpic[];
}

interface GeneratedEpic {
  title: string;
  description: string;
  features: GeneratedFeature[];
}

interface GeneratedFeature {
  title: string;
  description: string;
  userStories: GeneratedUserStory[];
}

interface GeneratedUserStory {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  storyPoints?: number;
}

type GenerationState = 'idle' | 'creating_sandbox' | 'waiting_sandbox' | 'sending' | 'waiting_response' | 'parsing' | 'saving' | 'complete' | 'error';

@Component({
  selector: 'app-backlog-generator-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent],
  template: `
    <div class="modal-backdrop" (click)="onBackdropClick($event)">
      <div class="modal-container">
        <div class="modal-header">
          <h2>Generate Backlog</h2>
          <button class="close-btn" (click)="modalClosed.emit()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        
        <div class="modal-body">
          @switch (state()) {
            @case ('idle') {
              <div class="prompt-section">
                <p class="description">
                  Generate a product backlog for <strong>{{ repositoryName() }}</strong> using AI analysis.
                  The AI will analyze the repository and create Epics, Features, and User Stories.
                </p>
                
                <div class="info-box">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                  <span>Runs in a temporary analysis container (same path as Code → Analyze). No desktop sandbox is opened.</span>
                </div>
                
                <div class="custom-prompt">
                  <label>Additional Instructions (optional)</label>
                  <textarea 
                    [(ngModel)]="customInstructions" 
                    placeholder="e.g., Focus on authentication features, prioritize mobile support..."
                    rows="3"></textarea>
                </div>
              </div>
            }
            
            @case ('creating_sandbox') {
              <div class="status-section">
                <div class="spinner"></div>
                <p>Creating sandbox environment...</p>
                <small>Setting up isolated container with your repository</small>
              </div>
            }
            
            @case ('waiting_sandbox') {
              <div class="status-section">
                <div class="spinner"></div>
                <p>Preparing environment…</p>
                <small>Waiting for the agent bridge (headless, no VNC)</small>
              </div>
            }
            
            @case ('sending') {
              <div class="status-section">
                <div class="spinner"></div>
                <p>Sending backlog request…</p>
              </div>
            }
            
            @case ('waiting_response') {
              <div class="status-section">
                <div class="spinner"></div>
                <p>Waiting for AI response…</p>
                <small>The agent analyzes your repository in the container. This may take a minute.</small>
              </div>
            }
            
            @case ('parsing') {
              <div class="status-section">
                <div class="spinner"></div>
                <p>Parsing backlog from AI response...</p>
              </div>
            }
            
            @case ('saving') {
              <div class="status-section">
                <div class="spinner"></div>
                <p>Saving backlog to database...</p>
              </div>
            }
            
            @case ('complete') {
              <div class="success-section">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M9 12l2 2 4-4"/>
                </svg>
                <h3>Backlog Generated!</h3>
                <p>Created {{ generatedBacklog()?.epics?.length || 0 }} epics</p>
              </div>
            }
            
            @case ('error') {
              <div class="error-section">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="15" y1="9" x2="9" y2="15"/>
                  <line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
                <h3>Error</h3>
                <p>{{ errorMessage() }}</p>
              </div>
            }
          }
        </div>
        
        <div class="modal-footer">
          @if (state() === 'idle') {
            <app-button variant="secondary" (click)="modalClosed.emit()">Cancel</app-button>
            <app-button 
              variant="primary" 
              (click)="generateBacklog()">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2a4 4 0 014 4c0 1.1-.9 2-2 2h-4a2 2 0 01-2-2 4 4 0 014-4z"/>
                <path d="M12 8v6"/>
              </svg>
              Generate Backlog
            </app-button>
          } @else if (state() === 'complete' || state() === 'error') {
            <app-button variant="primary" (click)="modalClosed.emit()">Close</app-button>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      backdrop-filter: blur(4px);
    }
    
    .modal-container {
      background: var(--bg-primary, #1a1a2e);
      border-radius: 12px;
      width: 90%;
      max-width: 600px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      border: 1px solid var(--border-color, #2a2a4a);
    }
    
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border-color, #2a2a4a);
    }
    
    .modal-header h2 {
      margin: 0;
      font-size: 1.25rem;
      color: var(--text-primary, #fff);
    }
    
    .close-btn {
      background: none;
      border: none;
      color: var(--text-secondary, #888);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      transition: all 0.2s;
    }
    
    .close-btn:hover {
      background: var(--bg-secondary, #252542);
      color: var(--text-primary, #fff);
    }
    
    .modal-body {
      padding: 1.5rem;
      overflow-y: auto;
      flex: 1;
    }
    
    .description {
      color: var(--text-secondary, #aaa);
      margin-bottom: 1rem;
      line-height: 1.6;
    }
    
    .warning-box, .info-box {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1rem;
      border-radius: 8px;
      margin-bottom: 1rem;
    }
    
    .warning-box {
      background: rgba(255, 193, 7, 0.1);
      border: 1px solid rgba(255, 193, 7, 0.3);
      color: #ffc107;
    }
    
    .info-box {
      background: rgba(33, 150, 243, 0.1);
      border: 1px solid rgba(33, 150, 243, 0.3);
      color: #2196f3;
    }
    
    .custom-prompt {
      margin-top: 1rem;
    }
    
    .custom-prompt label {
      display: block;
      color: var(--text-secondary, #aaa);
      font-size: 0.875rem;
      margin-bottom: 0.5rem;
    }
    
    .custom-prompt textarea {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid var(--border-color, #2a2a4a);
      border-radius: 8px;
      background: var(--bg-secondary, #252542);
      color: var(--text-primary, #fff);
      resize: vertical;
      font-family: inherit;
    }
    
    .custom-prompt textarea:focus {
      outline: none;
      border-color: var(--primary-color, #6366f1);
    }
    
    .status-section, .success-section, .error-section {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 2rem 1rem;
    }
    
    .status-section p, .success-section p, .error-section p {
      color: var(--text-secondary, #aaa);
      margin: 0.5rem 0;
    }
    
    .status-section small {
      color: var(--text-muted, #666);
      font-size: 0.8rem;
    }
    
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--border-color, #2a2a4a);
      border-top-color: var(--primary-color, #6366f1);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 1rem;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .success-section svg {
      color: #22c55e;
      margin-bottom: 1rem;
    }
    
    .success-section h3 {
      color: #22c55e;
      margin: 0;
    }
    
    .error-section svg {
      color: #ef4444;
      margin-bottom: 1rem;
    }
    
    .error-section h3 {
      color: #ef4444;
      margin: 0;
    }
    
    .response-preview {
      margin-top: 1rem;
      padding: 1rem;
      background: var(--bg-secondary, #252542);
      border-radius: 8px;
      text-align: left;
      max-height: 200px;
      overflow-y: auto;
      width: 100%;
    }
    
    .response-preview strong {
      color: var(--text-primary, #fff);
      display: block;
      margin-bottom: 0.5rem;
    }
    
    .response-text {
      color: var(--text-secondary, #aaa);
      font-size: 0.875rem;
      line-height: 1.5;
    }
    
    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
      padding: 1rem 1.5rem;
      border-top: 1px solid var(--border-color, #2a2a4a);
    }
  `]
})
export class BacklogGeneratorModalComponent implements OnInit, OnDestroy {
  repositoryId = input.required<string>();
  repositoryName = input.required<string>();
  modalClosed = output<void>();
  generated = output<void>();

  state = signal<GenerationState>('idle');
  errorMessage = signal<string>('');
  customInstructions = '';
  generatedBacklog = signal<GeneratedBacklog | null>(null);
  repository = signal<Repository | null>(null);

  private destroy$ = new Subject<void>();
  private backlogGenSandboxId: string | null = null;

  constructor(
    private sandboxBridgeService: SandboxBridgeService,
    private sandboxService: SandboxService,
    private backlogService: BacklogService,
    private repositoryService: RepositoryService,
    private artifactFeedService: ArtifactFeedService
  ) { }

  ngOnInit(): void {
    this.loadRepository();
  }

  private loadRepository(): void {
    this.repositoryService.getRepositories().subscribe({
      next: (repos) => {
        const repo = repos.find(r => r.id === this.repositoryId());
        if (repo) {
          this.repository.set(repo);
        }
      }
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('modal-backdrop')) {
      this.modalClosed.emit();
    }
  }

  generateBacklog(): void {
    this.createSandboxAndGenerate();
  }

  private createSandboxAndGenerate(): void {
    const repo = this.repository();
    if (!repo) {
      this.state.set('error');
      this.errorMessage.set('Repository not found. Please try again.');
      return;
    }

    this.state.set('creating_sandbox');
    this.errorMessage.set('');

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
      repo_url: repoUrl,
      repo_name: repo.name,
      repo_branch: repo.defaultBranch || 'main',
      repo_archive_url: repoArchiveUrl,
      artifact_feeds: artifactFeeds?.length ? artifactFeeds : undefined,
    }).subscribe({
      next: (sandbox) => {
        void this.runHeadlessBacklogGeneration(sandbox, repo);
      },
      error: (err) => {
        console.error('Failed to create sandbox:', err);
        this.state.set('error');
        this.errorMessage.set('Failed to create sandbox: ' + (err.message || 'Unknown error'));
      }
    });
  }

  private async runHeadlessBacklogGeneration(sandbox: CreateSandboxResponse, repo: Repository): Promise<void> {
    if (!sandbox.id) {
      this.state.set('error');
      this.errorMessage.set('Sandbox ID not available');
      return;
    }
    const sid = sandbox.id;
    this.backlogGenSandboxId = sid;
    try {
      this.state.set('waiting_sandbox');
      await this.delay(Math.min(5000, VPS_CONFIG.sandboxReadyDelayMs));
      await this.waitForZedReady(sid);

      this.state.set('sending');
      const prompt = this.buildBacklogPrompt();
      const post = await firstValueFrom(
        this.sandboxBridgeService.sendHeadlessAgentPrompt(sid, prompt).pipe(
          catchError((err: { status?: number }) => {
            if (err?.status === 409) {
              return of({
                status: 'error' as const,
                error: 'Another agent task is running. Try again in a few seconds.'
              });
            }
            throw err;
          })
        )
      );

      if (post.status !== 'ok') {
        throw new Error('error' in post && post.error ? post.error : 'Failed to start backlog generation');
      }
      const promptId = post.prompt_id;
      if (!promptId) {
        throw new Error('Failed to start backlog generation');
      }

      this.state.set('waiting_response');
      const response = await this.pollForHeadlessBacklogAnswer(sid, promptId);
      this.parseAndSaveBacklog(response);
    } catch (err: unknown) {
      console.error('Headless backlog generation failed:', err);
      this.state.set('error');
      this.errorMessage.set(err instanceof Error ? err.message : 'Backlog generation failed');
      this.cleanupBacklogSandbox();
    }
  }

  private async pollForHeadlessBacklogAnswer(sandboxId: string, promptId: string): Promise<string> {
    const maxAttempts = 3000;
    for (let i = 0; i < maxAttempts; i++) {
      const all = await firstValueFrom(this.sandboxBridgeService.getAllConversations(sandboxId));
      const hit = all.conversations.find(c => c.id === promptId);
      const body = hit?.assistant_message?.trim();
      if (body && this.containsBacklogJson(body)) {
        return body;
      }
      const running = await firstValueFrom(this.sandboxBridgeService.getAgentRunningStatus(sandboxId));
      if (!running.running && i > 8 && body && !this.containsBacklogJson(body)) {
        throw new Error('Agent finished without valid backlog JSON. Try again.');
      }
      if (!running.running && i > 8 && !body) {
        throw new Error('Agent finished without a recorded answer. Try again.');
      }
      await this.delay(400);
    }
    throw new Error('Backlog generation timed out. Please try again.');
  }

  private async waitForZedReady(sandboxId: string, maxAttempts = 60): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await firstValueFrom(this.sandboxBridgeService.health(sandboxId));
        if (response.status === 'ok') {
          await this.delay(3000);
          return;
        }
      } catch {
        // not ready
      }
      await this.delay(2000);
    }
    throw new Error('Sandbox bridge did not become ready in time');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private cleanupBacklogSandbox(): void {
    const id = this.backlogGenSandboxId;
    if (id) {
      this.sandboxService.deleteSandbox(id).subscribe({
        error: (e) => console.warn('Failed to delete backlog sandbox:', e)
      });
      this.backlogGenSandboxId = null;
    }
  }

  private buildRepoCloneUrl(repo: Repository): string {
    if (repo.cloneUrl) {
      return repo.cloneUrl;
    }
    return `https://github.com/${repo.fullName}.git`;
  }

  private buildBacklogPrompt(): string {
    let prompt = `Please analyze this repository and generate a product backlog in JSON format.

Create a structured backlog with:
- 3-5 Epics (major features or initiatives)
- 2-4 Features per Epic
- 2-3 User Stories per Feature

For each item, provide:
- A clear, concise title
- A detailed description
- For User Stories: acceptance criteria and story points (1, 2, 3, 5, or 8)

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

    if (this.customInstructions.trim()) {
      prompt += `\n\nAdditional requirements:\n${this.customInstructions}`;
    }

    return prompt;
  }

  private containsBacklogJson(response: string): boolean {
    // Check if response contains a JSON code block with "epics"
    return response.includes('"epics"') && (response.includes('```json') || response.includes('"features"'));
  }

  private parseAndSaveBacklog(response: string): void {
    this.state.set('parsing');

    try {
      // Extract JSON from markdown code block
      let jsonStr = response;

      // Try to extract from code block
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      } else {
        // Try to find raw JSON
        const jsonStart = response.indexOf('{');
        const jsonEnd = response.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
          jsonStr = response.substring(jsonStart, jsonEnd + 1);
        }
      }

      const backlog: GeneratedBacklog = JSON.parse(jsonStr);

      if (!backlog.epics || !Array.isArray(backlog.epics)) {
        throw new Error('Invalid backlog format: missing epics array');
      }

      this.generatedBacklog.set(backlog);
      this.saveBacklog(backlog);
    } catch (err) {
      console.error('Failed to parse backlog JSON:', err);
      this.state.set('error');
      this.errorMessage.set('Failed to parse AI response as backlog. The AI may not have returned valid JSON.');
      this.cleanupBacklogSandbox();
    }
  }

  private saveBacklog(backlog: GeneratedBacklog): void {
    this.state.set('saving');

    this.backlogService.createBacklog(this.repositoryId(), backlog).subscribe({
      next: () => {
        this.state.set('complete');
        this.cleanupBacklogSandbox();
        this.generated.emit();
      },
      error: (err) => {
        console.error('Failed to save backlog:', err);
        this.state.set('error');
        this.errorMessage.set('Failed to save backlog to database: ' + (err.message || 'Unknown error'));
        this.cleanupBacklogSandbox();
      }
    });
  }
}
