import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subscription, interval, firstValueFrom } from 'rxjs';
import { takeWhile, switchMap } from 'rxjs/operators';
import { 
  RepositoryService, 
  RepositoryTree, 
  RepositoryTreeItem, 
  RepositoryFileContent,
  RepositoryBranch,
  PullRequest,
  CodeAnalysisResult,
  FileAnalysisResult
} from '../../core/services/repository.service';
import { SandboxService, CreateSandboxResponse } from '../../core/services/sandbox.service';
import { AIConfigService } from '../../core/services/ai-config.service';
import { VncViewerService } from '../../core/services/vnc-viewer.service';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe';
import { Repository } from '../../shared/models/repository.model';
import { CodeHighlightPipe } from '../../shared/pipes/code-highlight.pipe';
import { VPS_CONFIG, getVncHtmlUrl } from '../../core/config/vps.config';

// Extended tree item with children and state
export interface TreeNode extends RepositoryTreeItem {
  children?: TreeNode[];
  isExpanded?: boolean;
  isLoading?: boolean;
  depth: number;
}

export type TabType = 'code' | 'pullRequests' | 'analysis';

/**
 * Code browser component - VS Code-like file explorer
 * Displays repository files as expandable tree
 */
@Component({
  selector: 'app-code',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, CodeHighlightPipe, MarkdownPipe],
  templateUrl: './code.component.html',
  styleUrl: './code.component.css'
})
export class CodeComponent implements OnInit, OnDestroy {
  // State signals
  repository = signal<Repository | null>(null);
  repositoryId = signal<string>('');
  currentBranch = signal<string>('');
  branches = signal<RepositoryBranch[]>([]);
  treeNodes = signal<TreeNode[]>([]);
  selectedFile = signal<RepositoryFileContent | null>(null);
  selectedFilePath = signal<string | null>(null);
  loading = signal<boolean>(false);
  fileLoading = signal<boolean>(false);
  error = signal<string | null>(null);
  showBranchDropdown = signal<boolean>(false);
  
  // Tab and PR state
  activeTab = signal<TabType>('code');
  pullRequests = signal<PullRequest[]>([]);
  prLoading = signal<boolean>(false);
  prFilter = signal<'all' | 'open' | 'closed'>('open');

  // Analysis state
  analysisResult = signal<CodeAnalysisResult | null>(null);
  analysisLoading = signal<boolean>(false);
  analysisError = signal<string | null>(null);
  analysisSandboxId = signal<string | null>(null);
  analysisStatus = signal<string>('');

  // File analysis state
  fileAnalysisResult = signal<FileAnalysisResult | null>(null);
  fileAnalysisLoading = signal<boolean>(false);
  fileAnalysisError = signal<string | null>(null);
  showFileExplanation = signal<boolean>(false);

  // Subscriptions for cleanup
  private analysisSubscription?: Subscription;

  // Computed: flattened tree for display
  flattenedTree = computed(() => {
    const result: TreeNode[] = [];
    const flatten = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (node.isExpanded && node.children) {
          flatten(node.children);
        }
      }
    };
    flatten(this.treeNodes());
    return result;
  });

  fileLines = computed(() => {
    const file = this.selectedFile();
    if (!file || file.isBinary) return [];
    return file.content.split('\n');
  });

  /** Lines with index for @for track (track by index) */
  fileLinesWithIndex = computed(() => {
    const lines = this.fileLines();
    return lines.map((line, index) => ({ line, index }));
  });

  /** Language for syntax highlighting (from file.language or file extension) */
  fileLanguage = computed(() => {
    const file = this.selectedFile();
    if (!file) return null;
    if (file.language) return file.language;
    const name = file.name || '';
    const dot = name.lastIndexOf('.');
    if (dot >= 0) return name.slice(dot + 1);
    if (name.toLowerCase() === 'dockerfile') return 'dockerfile';
    return null;
  });

  // PR computed values
  filteredPullRequests = computed(() => {
    const prs = this.pullRequests();
    const filter = this.prFilter();
    if (filter === 'all') return prs;
    if (filter === 'open') return prs.filter(pr => pr.state === 'open');
    return prs.filter(pr => pr.state === 'closed' || pr.state === 'merged');
  });

  openPrCount = computed(() => this.pullRequests().filter(pr => pr.state === 'open').length);
  closedPrCount = computed(() => this.pullRequests().filter(pr => pr.state !== 'open').length);

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private repositoryService: RepositoryService,
    private sandboxService: SandboxService,
    private aiConfigService: AIConfigService,
    private vncViewerService: VncViewerService,
    private http: HttpClient
  ) {}

  ngOnDestroy(): void {
    this.analysisSubscription?.unsubscribe();
    // Don't delete sandbox on destroy - allow reconnection after refresh
    // Sandbox will be cleaned up when analysis completes or user explicitly cancels
  }

  ngOnInit(): void {
    const repoId = this.route.snapshot.paramMap.get('repositoryId');
    if (repoId) {
      this.repositoryId.set(repoId);
      this.loadRepository(repoId);
      
      // Check for existing analysis sandbox to reconnect after refresh
      this.checkForExistingAnalysisSandbox();
    } else {
      this.error.set('Repository ID is required');
    }
  }

  /**
   * Check if there's an existing analysis sandbox running (e.g., after page refresh)
   * If found, reconnect and resume polling for the analysis response
   */
  private checkForExistingAnalysisSandbox(): void {
    const currentRepoId = this.repositoryId();
    const viewers = this.vncViewerService.getViewers();
    
    // Only reconnect to analysis sandbox for the CURRENT repository
    const analysisViewer = viewers.find(v => 
      v.title?.includes('Analysis') && 
      v.implementationContext?.repositoryId === currentRepoId
    );
    
    if (analysisViewer && analysisViewer.bridgePort) {
      console.log('Found existing analysis sandbox for this repo, reconnecting...', analysisViewer.id);
      
      this.analysisSandboxId.set(analysisViewer.id);
      this.analysisLoading.set(true);
      this.analysisStatus.set('Reconnecting to analysis...');
      
      // Resume polling for the response
      const bridgeUrl = `http://${VPS_CONFIG.ip}:${analysisViewer.bridgePort}`;
      this.resumeAnalysisPolling(bridgeUrl, analysisViewer.id);
    }
  }

  /**
   * Resume polling for analysis response after reconnecting to an existing sandbox
   */
  private async resumeAnalysisPolling(bridgeUrl: string, sandboxId: string): Promise<void> {
    const branch = this.currentBranch() || 'main';
    
    try {
      this.analysisStatus.set('Waiting for AI response...');
      const response = await this.waitForZedResponse(bridgeUrl);
      
      // Save the response
      this.analysisStatus.set('Saving results...');
      this.repositoryService.saveCodeAnalysis(this.repositoryId(), {
        branch,
        summary: response,
        model: 'zed-ai'
      }).subscribe({
        next: (result) => {
          this.analysisResult.set(result);
          this.analysisLoading.set(false);
          this.analysisStatus.set('');
          this.cleanupAnalysisSandbox();
        },
        error: (err) => {
          console.error('Failed to save analysis:', err);
          this.analysisError.set('Failed to save analysis results');
          this.analysisLoading.set(false);
          this.cleanupAnalysisSandbox();
        }
      });
    } catch (err: any) {
      console.error('Resumed analysis failed:', err);
      this.analysisError.set(err.message || 'Analysis failed');
      this.analysisLoading.set(false);
      this.cleanupAnalysisSandbox();
    }
  }

  private async loadRepository(repositoryId: string): Promise<void> {
    let repo = this.repositoryService.getRepositoryById(repositoryId);
    
    if (!repo) {
      this.repositoryService.getRepositories().subscribe({
        next: () => {
          repo = this.repositoryService.getRepositoryById(repositoryId);
          if (repo) {
            this.repository.set(repo);
            this.loadBranchesAndTree(repositoryId);
          } else {
            this.error.set('Repository not found');
          }
        },
        error: (err) => {
          this.error.set(err.message || 'Failed to load repository');
        }
      });
    } else {
      this.repository.set(repo);
      this.loadBranchesAndTree(repositoryId);
    }
  }

  private loadBranchesAndTree(repositoryId: string): void {
    this.loading.set(true);
    this.error.set(null);

    this.repositoryService.getBranches(repositoryId).subscribe({
      next: (branches) => {
        this.branches.set(branches);
        const defaultBranch = branches.find(b => b.isDefault)?.name || branches[0]?.name || 'main';
        this.currentBranch.set(defaultBranch);
        this.loadRootTree();
      },
      error: (err) => {
        console.warn('Failed to load branches:', err);
        this.currentBranch.set(this.repository()?.defaultBranch || 'main');
        this.loadRootTree();
      }
    });
  }

  loadRootTree(): void {
    const repoId = this.repositoryId();
    const branch = this.currentBranch();

    this.loading.set(true);

    this.repositoryService.getRepositoryTree(repoId, undefined, branch || undefined).subscribe({
      next: (tree) => {
        const nodes = this.convertToTreeNodes(tree.items, 0);
        this.treeNodes.set(nodes);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to load repository contents');
        this.loading.set(false);
      }
    });
  }

  private convertToTreeNodes(items: RepositoryTreeItem[], depth: number): TreeNode[] {
    return items.map(item => ({
      ...item,
      depth,
      isExpanded: false,
      isLoading: false,
      children: item.type === 'dir' ? undefined : undefined
    }));
  }

  toggleFolder(node: TreeNode): void {
    if (node.type !== 'dir') return;

    if (node.isExpanded) {
      // Collapse
      this.updateNode(node.path, { isExpanded: false });
    } else {
      // Expand - load children if not loaded
      if (!node.children) {
        this.loadFolderContents(node);
      } else {
        this.updateNode(node.path, { isExpanded: true });
      }
    }
  }

  private loadFolderContents(node: TreeNode): void {
    const repoId = this.repositoryId();
    const branch = this.currentBranch();

    this.updateNode(node.path, { isLoading: true });

    this.repositoryService.getRepositoryTree(repoId, node.path, branch || undefined).subscribe({
      next: (tree) => {
        const children = this.convertToTreeNodes(tree.items, node.depth + 1);
        this.updateNode(node.path, { 
          children, 
          isExpanded: true, 
          isLoading: false 
        });
      },
      error: (err) => {
        console.error('Failed to load folder contents:', err);
        this.updateNode(node.path, { isLoading: false });
      }
    });
  }

  private updateNode(path: string, updates: Partial<TreeNode>): void {
    const updateRecursive = (nodes: TreeNode[]): TreeNode[] => {
      return nodes.map(node => {
        if (node.path === path) {
          return { ...node, ...updates };
        }
        if (node.children) {
          return { ...node, children: updateRecursive(node.children) };
        }
        return node;
      });
    };

    this.treeNodes.update(nodes => updateRecursive(nodes));
  }

  onNodeClick(node: TreeNode): void {
    if (node.type === 'dir') {
      this.toggleFolder(node);
    } else if (node.type === 'file') {
      this.loadFileContent(node.path);
    }
  }

  loadFileContent(path: string): void {
    const repoId = this.repositoryId();
    const branch = this.currentBranch();

    this.fileLoading.set(true);
    this.selectedFilePath.set(path);
    
    // Clear previous file analysis
    this.fileAnalysisResult.set(null);
    this.fileAnalysisError.set(null);
    this.showFileExplanation.set(false);

    this.repositoryService.getFileContent(repoId, path, branch || undefined).subscribe({
      next: (content) => {
        this.selectedFile.set(content);
        this.fileLoading.set(false);
        
        // Try to load stored analysis for this file
        this.loadFileAnalysis(path);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to load file content');
        this.fileLoading.set(false);
      }
    });
  }

  closeFile(): void {
    this.selectedFile.set(null);
    this.selectedFilePath.set(null);
    this.fileAnalysisResult.set(null);
    this.fileAnalysisError.set(null);
    this.showFileExplanation.set(false);
  }

  copyFileContent(): void {
    const file = this.selectedFile();
    if (!file || file.isBinary) return;
    navigator.clipboard.writeText(file.content).then(
      () => { /* optional: show toast */ },
      () => { /* fallback or ignore */ }
    );
  }

  toggleBranchDropdown(): void {
    this.showBranchDropdown.update(v => !v);
  }

  selectBranch(branch: RepositoryBranch): void {
    this.currentBranch.set(branch.name);
    this.showBranchDropdown.set(false);
    this.selectedFile.set(null);
    this.selectedFilePath.set(null);
    this.loadRootTree();
  }

  getFileIcon(item: TreeNode | RepositoryTreeItem): string {
    if (item.type === 'dir') {
      return 'folder';
    }
    
    const ext = item.name.split('.').pop()?.toLowerCase() || '';
    const iconMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript',
      'jsx': 'javascript',
      'py': 'python',
      'java': 'java',
      'cs': 'csharp',
      'go': 'go',
      'rs': 'rust',
      'rb': 'ruby',
      'php': 'php',
      'html': 'html',
      'css': 'css',
      'scss': 'css',
      'json': 'json',
      'xml': 'xml',
      'yaml': 'yaml',
      'yml': 'yaml',
      'md': 'markdown',
      'sql': 'database',
      'sh': 'terminal',
      'dockerfile': 'docker',
      'png': 'image',
      'jpg': 'image',
      'jpeg': 'image',
      'gif': 'image',
      'svg': 'image',
      'pdf': 'pdf',
      'zip': 'archive',
      'tar': 'archive',
      'gz': 'archive',
    };

    return iconMap[ext] || 'file';
  }

  formatFileSize(size?: number): string {
    if (!size) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  goBack(): void {
    this.router.navigate(['/repositories']);
  }

  // Tab methods
  switchTab(tab: TabType): void {
    this.activeTab.set(tab);
    if (tab === 'pullRequests' && this.pullRequests().length === 0) {
      this.loadPullRequests();
    }
    if (tab === 'analysis' && !this.analysisResult() && !this.analysisLoading()) {
      this.loadAnalysis();
    }
  }

  loadPullRequests(): void {
    const repoId = this.repositoryId();
    this.prLoading.set(true);

    this.repositoryService.getPullRequests(repoId, 'all').subscribe({
      next: (prs) => {
        this.pullRequests.set(prs);
        this.prLoading.set(false);
      },
      error: (err) => {
        console.error('Failed to load pull requests:', err);
        this.prLoading.set(false);
      }
    });
  }

  setPrFilter(filter: 'all' | 'open' | 'closed'): void {
    this.prFilter.set(filter);
  }

  getRelativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    const diffWeek = Math.floor(diffDay / 7);
    const diffMonth = Math.floor(diffDay / 30);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin} minute${diffMin > 1 ? 's' : ''} ago`;
    if (diffHour < 24) return `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
    if (diffDay < 7) return `${diffDay} day${diffDay > 1 ? 's' : ''} ago`;
    if (diffWeek < 4) return `${diffWeek} week${diffWeek > 1 ? 's' : ''} ago`;
    return `${diffMonth} month${diffMonth > 1 ? 's' : ''} ago`;
  }

  openPrUrl(url: string): void {
    window.open(url, '_blank');
  }

  // Analysis methods
  loadAnalysis(): void {
    const repoId = this.repositoryId();
    const branch = this.currentBranch();
    this.analysisLoading.set(true);
    this.analysisError.set(null);

    this.repositoryService.getCodeAnalysis(repoId, branch).subscribe({
      next: (result) => {
        this.analysisResult.set(result);
        this.analysisLoading.set(false);
      },
      error: (err) => {
        // 404 means no analysis yet - that's OK
        if (err.status !== 404) {
          console.error('Failed to load analysis:', err);
        }
        this.analysisLoading.set(false);
      }
    });
  }

  triggerAnalysis(): void {
    const repo = this.repository();
    const repoId = this.repositoryId();
    const branch = this.currentBranch();
    
    if (!repo) {
      this.analysisError.set('Repository not loaded');
      return;
    }

    // Check if AI is configured
    const aiProviderConfig = this.aiConfigService.defaultProvider();
    if (!aiProviderConfig.apiKey) {
      this.analysisError.set('AI is not configured. Please configure AI settings first.');
      return;
    }

    this.analysisLoading.set(true);
    this.analysisError.set(null);
    this.analysisStatus.set('Creating sandbox...');

    // Build AI config for sandbox
    const aiConfig = {
      provider: aiProviderConfig.provider,
      api_key: aiProviderConfig.apiKey,
      model: aiProviderConfig.model,
      base_url: aiProviderConfig.baseUrl
    };

    // Get authenticated clone URL
    this.repositoryService.getAuthenticatedCloneUrl(repoId).subscribe({
      next: (result) => {
        this.createAnalysisSandbox(repo, result.cloneUrl, branch, aiConfig);
      },
      error: (err) => {
        console.error('Failed to get authenticated clone URL:', err);
        // Fallback to regular URL using cloneUrl from repo
        this.createAnalysisSandbox(repo, repo.cloneUrl, branch, aiConfig);
      }
    });
  }

  private createAnalysisSandbox(repo: Repository, cloneUrl: string, branch: string, aiConfig: any): void {
    this.sandboxService.createSandbox({
      repo_url: cloneUrl,
      repo_name: repo.name,
      repo_branch: branch,
      ai_config: aiConfig
    }).subscribe({
      next: (sandbox) => {
        this.analysisSandboxId.set(sandbox.id);
        this.analysisStatus.set('Waiting for environment...');
        
        // Open VNC viewer in minimized state after delay
        setTimeout(() => {
          this.vncViewerService.open(
            {
              url: getVncHtmlUrl(sandbox.port),
              autoConnect: true,
              scalingMode: 'local',
              useIframe: true
            },
            sandbox.id,
            `${repo.name} - Analysis`,
            sandbox.bridge_port,
            // Store repositoryId so we can reconnect after page refresh
            {
              repositoryId: this.repositoryId(),
              repositoryFullName: repo.fullName || repo.name,
              defaultBranch: branch,
              storyTitle: 'Code Analysis',
              storyId: `analysis-${this.repositoryId()}`
            }
          );
          
          // Start analysis after viewer is opened
          this.waitForZedAndAnalyze(sandbox, repo.name, branch);
        }, VPS_CONFIG.sandboxReadyDelayMs);
      },
      error: (err) => {
        console.error('Failed to create sandbox:', err);
        this.analysisError.set('Failed to create analysis environment');
        this.analysisLoading.set(false);
      }
    });
  }

  private async waitForZedAndAnalyze(sandbox: CreateSandboxResponse, repoName: string, branch: string): Promise<void> {
    const bridgePort = sandbox.bridge_port;
    if (!bridgePort) {
      this.analysisError.set('Sandbox bridge port not available');
      this.analysisLoading.set(false);
      this.cleanupAnalysisSandbox();
      return;
    }

    const bridgeUrl = `http://${VPS_CONFIG.ip}:${bridgePort}`;
    
    try {
      // Wait for Zed to be ready (poll health endpoint)
      this.analysisStatus.set('Waiting for Zed IDE...');
      await this.waitForZedReady(bridgeUrl);

      // Send analysis prompt
      this.analysisStatus.set('Analyzing repository...');
      const prompt = this.buildAnalysisPrompt(repoName);
      await this.sendPromptToZed(bridgeUrl, prompt);

      // Wait for response
      this.analysisStatus.set('Waiting for AI response...');
      const response = await this.waitForZedResponse(bridgeUrl);

      // Parse and save response
      this.analysisStatus.set('Saving results...');
      
      // Store the full response as summary for comprehensive display
      this.repositoryService.saveCodeAnalysis(this.repositoryId(), {
        branch,
        summary: response, // Store full markdown response
        model: 'zed-ai'
      }).subscribe({
        next: (result) => {
          this.analysisResult.set(result);
          this.analysisLoading.set(false);
          this.analysisStatus.set('');
          this.cleanupAnalysisSandbox();
        },
        error: (err) => {
          console.error('Failed to save analysis:', err);
          this.analysisError.set('Failed to save analysis results');
          this.analysisLoading.set(false);
          this.cleanupAnalysisSandbox();
        }
      });

    } catch (err: any) {
      console.error('Analysis failed:', err);
      this.analysisError.set(err.message || 'Analysis failed');
      this.analysisLoading.set(false);
      this.cleanupAnalysisSandbox();
    }
  }

  private async waitForZedReady(bridgeUrl: string, maxAttempts = 60): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await firstValueFrom(
          this.http.get<{ status: string }>(`${bridgeUrl}/health`)
        );
        if (response.status === 'ok') {
          // Wait a bit more for Zed to fully initialize
          await this.delay(3000);
          return;
        }
      } catch {
        // Not ready yet
      }
      await this.delay(2000);
    }
    throw new Error('Zed IDE did not become ready in time');
  }

  private async sendPromptToZed(bridgeUrl: string, prompt: string): Promise<void> {
    await firstValueFrom(
      this.http.post(`${bridgeUrl}/zed/send-prompt`, { prompt })
    );
  }

  private async waitForZedResponse(bridgeUrl: string, maxAttempts = 600): Promise<string> {
    // 600 attempts * 2 seconds = 20 minutes max wait time for comprehensive analysis
    let lastMessageLength = 0;
    let stableCount = 0;
    let initialConversationId: string | null = null;
    
    // First, get the current conversation ID to detect new responses
    try {
      const initial = await firstValueFrom(
        this.http.get<{ id: string; assistant_message: string } | null>(`${bridgeUrl}/zed/latest`)
      );
      if (initial) {
        initialConversationId = initial.id;
      }
    } catch {
      // No existing conversation
    }
    
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await firstValueFrom(
          this.http.get<{ id: string; assistant_message: string; user_message: string } | null>(`${bridgeUrl}/zed/latest`)
        );
        
        if (response && response.assistant_message) {
          const content = response.assistant_message;
          
          // Only consider responses from our prompt (new conversation or updated one)
          const isNewConversation = !initialConversationId || response.id !== initialConversationId;
          const hasContent = content.length > 100;
          
          // Update status with progress
          if (hasContent) {
            const elapsedMinutes = Math.floor((i * 2) / 60);
            const charCount = Math.floor(content.length / 1000);
            this.analysisStatus.set(`Analyzing... ${charCount}k chars received (${elapsedMinutes}m elapsed)`);
          }
          
          if (isNewConversation && hasContent) {
            // Check if response is complete (stable for a few polls)
            if (content.length === lastMessageLength) {
              stableCount++;
              if (stableCount >= 4) {
                // Response is stable, consider it complete
                console.log('Response complete, length:', content.length);
                return content;
              }
            } else {
              lastMessageLength = content.length;
              stableCount = 0;
            }
          }
        }
      } catch (err) {
        console.warn('Error polling Zed conversation:', err);
      }
      await this.delay(2000);
    }
    throw new Error('Analysis timed out after 20 minutes. Please try again.');
  }

  private buildAnalysisPrompt(repoName: string): string {
    return `Analyze this repository "${repoName}" and provide a comprehensive code analysis report. Examine the entire codebase structure carefully and provide:

## Summary
A brief executive summary of what this repository does, its purpose, and target users (3-4 sentences).

## Architecture Diagram
Create a Mermaid diagram showing the high-level architecture. Use flowchart or graph notation:

\`\`\`mermaid
graph TD
    subgraph "Layer Name"
        A[Component] --> B[Component]
    end
\`\`\`

## Architecture Details
Describe the overall architecture in detail:
- **Design Patterns**: What architectural patterns are used (MVC, Clean Architecture, Microservices, etc.)?
- **Layer Organization**: How is the code organized into layers/modules?
- **Data Flow**: How does data flow through the application?

## Code Quality Metrics
Provide an assessment of code quality:

| Metric | Rating | Notes |
|--------|--------|-------|
| **Maintainability** | ⭐⭐⭐⭐⭐ | Assessment |
| **Code Organization** | ⭐⭐⭐⭐⭐ | Assessment |
| **Documentation** | ⭐⭐⭐⭐⭐ | Assessment |
| **Test Coverage** | ⭐⭐⭐⭐⭐ | Assessment |
| **Security Practices** | ⭐⭐⭐⭐⭐ | Assessment |
| **Performance** | ⭐⭐⭐⭐⭐ | Assessment |

Use filled stars (⭐) for the rating out of 5.

## Key Components
List and describe the main components with their responsibilities:

| Component | Type | Description |
|-----------|------|-------------|
| Name | (Service/Controller/Module) | What it does |

## Component Relationships
Create a Mermaid diagram showing how key components interact:

\`\`\`mermaid
graph LR
    A[Component A] -->|calls| B[Component B]
    B -->|returns| A
\`\`\`

## Dependencies Analysis
Analyze the external dependencies:

| Dependency | Version | Purpose | Risk Level |
|------------|---------|---------|------------|
| Package name | Version | What it's used for | Low/Medium/High |

## Technical Debt
Identify any technical debt or areas needing attention:
- List specific issues found
- Prioritize by impact (High/Medium/Low)

## Security Considerations
Note any security-related observations:
- Authentication/Authorization patterns
- Data validation practices
- Potential vulnerabilities

## Recommendations
Provide actionable recommendations prioritized by importance:

### High Priority
- Critical improvements needed

### Medium Priority  
- Important but not urgent

### Low Priority
- Nice to have improvements

## Summary Statistics
Provide rough estimates where possible:
- **Total Files**: ~X files
- **Primary Languages**: List languages
- **Estimated Lines of Code**: ~X lines
- **Test Files**: ~X test files

Be thorough and specific. Use the markdown formatting exactly as shown above for proper rendering.`;
  }

  private parseAnalysisResponse(response: string): {
    summary: string;
    architecture?: string;
    keyComponents?: string;
    dependencies?: string;
    recommendations?: string;
  } {
    const sections: Record<string, string> = {};
    const sectionNames = ['Summary', 'Architecture', 'Key Components', 'Dependencies', 'Recommendations'];
    
    for (const name of sectionNames) {
      const regex = new RegExp(`##\\s*${name}[\\s\\S]*?(?=##|$)`, 'i');
      const match = response.match(regex);
      if (match) {
        // Remove the header and trim
        const content = match[0].replace(/##\s*\w+[\w\s]*/i, '').trim();
        sections[name.toLowerCase().replace(/\s+/g, '')] = content;
      }
    }

    return {
      summary: sections['summary'] || response.substring(0, 500),
      architecture: sections['architecture'],
      keyComponents: sections['keycomponents'],
      dependencies: sections['dependencies'],
      recommendations: sections['recommendations']
    };
  }

  private cleanupAnalysisSandbox(): void {
    const sandboxId = this.analysisSandboxId();
    if (sandboxId) {
      // Close VNC viewer
      this.vncViewerService.close(sandboxId);
      
      // Delete sandbox
      this.sandboxService.deleteSandbox(sandboxId).subscribe({
        next: () => console.log('Analysis sandbox cleaned up'),
        error: (err) => console.warn('Failed to cleanup sandbox:', err)
      });
      this.analysisSandboxId.set(null);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  refreshAnalysis(): void {
    const repoId = this.repositoryId();
    
    // Delete existing analysis first, then trigger new one
    this.repositoryService.deleteAnalysis(repoId).subscribe({
      next: () => {
        this.analysisResult.set(null);
        this.triggerAnalysis();
      },
      error: (err) => {
        console.error('Failed to delete analysis:', err);
        // Try to trigger anyway
        this.triggerAnalysis();
      }
    });
  }

  formatAnalysisDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // File Analysis methods
  toggleFileExplanation(): void {
    this.showFileExplanation.update(v => !v);
  }

  loadFileAnalysis(filePath: string): void {
    const repoId = this.repositoryId();
    const branch = this.currentBranch();

    this.repositoryService.getFileAnalysis(repoId, filePath, branch).subscribe({
      next: (result) => {
        this.fileAnalysisResult.set(result);
      },
      error: () => {
        // 404 means no analysis yet - that's OK, don't show error
      }
    });
  }

  triggerFileAnalysis(): void {
    const file = this.selectedFile();
    if (!file || file.isBinary) return;

    const repoId = this.repositoryId();
    const branch = this.currentBranch();

    this.fileAnalysisLoading.set(true);
    this.fileAnalysisError.set(null);
    this.showFileExplanation.set(true);

    this.repositoryService.analyzeFile(repoId, file.path, file.content, branch).subscribe({
      next: (result) => {
        this.fileAnalysisResult.set(result);
        this.fileAnalysisLoading.set(false);
      },
      error: (err) => {
        console.error('Failed to analyze file:', err);
        this.fileAnalysisError.set(err.error?.message || 'Failed to analyze file');
        this.fileAnalysisLoading.set(false);
      }
    });
  }

  refreshFileAnalysis(): void {
    this.fileAnalysisResult.set(null);
    this.triggerFileAnalysis();
  }
}
