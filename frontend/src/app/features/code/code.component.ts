import {
  Component,
  OnInit,
  OnDestroy,
  HostListener,
  signal,
  computed,
  viewChild,
  ElementRef,
  effect
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subject, Subscription, interval, firstValueFrom, of } from 'rxjs';
import { takeUntil, takeWhile, switchMap, catchError } from 'rxjs/operators';
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
import { SandboxBridgeService, ZedConversation, ConversationMessage } from '../../core/services/sandbox-bridge.service';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe';
import { Repository } from '../../shared/models/repository.model';
import { CodeHighlightPipe } from '../../shared/pipes/code-highlight.pipe';
import { VPS_CONFIG } from '../../core/config/vps.config';
import { LastVisitedRepositoryService } from '../../core/services/last-visited-repository.service';
import { CodeAskConversationService } from '../../core/services/code-ask-conversation.service';

// Extended tree item with children and state
export interface TreeNode extends RepositoryTreeItem {
  children?: TreeNode[];
  isExpanded?: boolean;
  isLoading?: boolean;
  depth: number;
}

export type TabType = 'code' | 'pullRequests' | 'analysis' | 'ask';

/** One turn in the Code “Ask” panel (headless sandbox agent). */
export interface CodeAskMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCallsSummary?: string;
}

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

  // LLM selector (repo override, same UI as branch dropdown)
  repoLlmUpdating = signal<boolean>(false);
  showLlmDropdown = signal<boolean>(false);

  /** On narrow viewports, either full-height explorer or full-height file viewer (see CSS). */
  codeMobilePane = signal<'explorer' | 'code'>('explorer');

  // Ask (headless agent — same bridge `/agent/prompt` as ACP tool loop; no VNC)
  codeChatMessages = signal<CodeAskMessage[]>([]);
  codeChatInput = signal<string>('');
  codeChatBusy = signal<boolean>(false);
  codeChatError = signal<string | null>(null);
  codeChatStatus = signal<string>('');
  codeChatSandboxId = signal<string | null>(null);
  /** VNC password from create response (needed to open the desktop viewer; not returned by GET). */
  codeChatVncPassword = signal<string | undefined>(undefined);
  /** If true, this sandbox was created for Ask and should be deleted on branch change / destroy. */
  codeChatSandboxOwned = signal<boolean>(false);
  /** Live tool calls while the headless agent is running (from /all-conversations headless_progress). */
  codeChatLiveTools = signal<{ name: string; args_preview?: string }[]>([]);
  /** Short status line from bridge live_response.content (current tool name or “Starting agent…”). */
  codeChatStreamHint = signal<string | null>(null);

  /** Avoid double restore when branches + tree load triggers twice. */
  private codeAskRestoreDoneForRepo: string | null = null;

  /** Ask tab: scrollable message list (auto-scroll to latest). */
  readonly codeAskScroll = viewChild<ElementRef<HTMLElement>>('codeAskScroll');

  // Subscriptions for cleanup
  private analysisSubscription?: Subscription;
  private destroy$ = new Subject<void>();

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

  /** Render Markdown files as HTML instead of a raw highlighted buffer */
  isMarkdownPreviewFile = computed(() => {
    const file = this.selectedFile();
    if (!file || file.isBinary) return false;
    const lang = (file.language || '').toLowerCase();
    if (lang === 'markdown' || lang === 'md') return true;
    const isMdPath = (s: string) => {
      const l = s.toLowerCase();
      return l.endsWith('.md') || l.endsWith('.mdx');
    };
    return isMdPath(file.name || '') || isMdPath(file.path || '');
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
    private sandboxBridgeService: SandboxBridgeService,
    private codeAskConversationService: CodeAskConversationService,
    private http: HttpClient,
    private lastVisitedRepository: LastVisitedRepositoryService
  ) {
    effect(() => {
      this.activeTab();
      this.codeChatMessages();
      this.codeChatBusy();
      this.codeChatLiveTools();
      this.codeChatStreamHint();
      this.codeChatStatus();
      this.codeChatError();
      if (this.activeTab() !== 'ask') {
        this.teardownAskThreadMutationObserver();
        return;
      }
      queueMicrotask(() => {
        this.scrollAskThreadToBottom();
        this.ensureAskThreadMutationObserver();
      });
    });
  }

  private askThreadMutationObserver: MutationObserver | null = null;
  private askThreadMutationRoot: HTMLElement | null = null;
  private askThreadMutationScheduled = false;

  /** Observe DOM changes inside the thread (e.g. markdown render) and stay pinned to bottom. */
  private ensureAskThreadMutationObserver(): void {
    const root = this.codeAskScroll()?.nativeElement ?? null;
    if (!root || root === this.askThreadMutationRoot) {
      return;
    }
    this.teardownAskThreadMutationObserver();
    this.askThreadMutationRoot = root;
    this.askThreadMutationObserver = new MutationObserver(() => {
      if (this.activeTab() !== 'ask' || this.askThreadMutationScheduled) {
        return;
      }
      this.askThreadMutationScheduled = true;
      requestAnimationFrame(() => {
        this.askThreadMutationScheduled = false;
        if (this.activeTab() !== 'ask') {
          return;
        }
        const el = this.codeAskScroll()?.nativeElement;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    });
    this.askThreadMutationObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  private teardownAskThreadMutationObserver(): void {
    this.askThreadMutationObserver?.disconnect();
    this.askThreadMutationObserver = null;
    this.askThreadMutationRoot = null;
  }

  /** Keep Ask chat scrolled to the latest message / streaming row. */
  private scrollAskThreadToBottom(): void {
    if (this.activeTab() !== 'ask') {
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = this.codeAskScroll()?.nativeElement;
        if (!el) {
          return;
        }
        el.scrollTop = el.scrollHeight;
      });
    });
  }

  ngOnDestroy(): void {
    this.teardownAskThreadMutationObserver();
    this.analysisSubscription?.unsubscribe();
    this.destroy$.next();
    this.destroy$.complete();
  }

  ngOnInit(): void {
    this.aiConfigService.loadLlmSettings();
    const repoId = this.route.snapshot.paramMap.get('repositoryId');
    if (repoId) {
      this.lastVisitedRepository.remember(repoId);
      this.repositoryId.set(repoId);
      this.loadRepository(repoId);

      // Check for existing analysis sandbox to reconnect after refresh
      this.checkForExistingAnalysisSandbox();
    } else {
      this.error.set('Repository ID is required');
    }

    // If the analysis sandbox viewer is closed while analysis is running, stop the spinner immediately
    this.vncViewerService.viewers$.pipe(takeUntil(this.destroy$)).subscribe(viewers => {
      const sandboxId = this.analysisSandboxId();
      if (sandboxId && this.analysisLoading()) {
        const stillOpen = viewers.some(v => v.id === sandboxId);
        if (!stillOpen) {
          this.analysisLoading.set(false);
          this.analysisError.set('Sandbox was closed. Analysis stopped.');
          this.analysisSandboxId.set(null);
        }
      }
    });
  }

  getLlmSettings() {
    return this.aiConfigService.llmSettings();
  }

  currentLlmLabel(): string {
    const repo = this.repository();
    const settingId = repo?.llmSettingId;
    if (!settingId) return 'Default';
    const llm = this.aiConfigService.llmSettings().find(s => s.id === settingId);
    return llm?.name || llm?.model || 'Default';
  }

  toggleLlmDropdown(): void {
    this.showLlmDropdown.update(v => !v);
  }

  selectLlmOption(llmSettingId: string | null): void {
    this.showLlmDropdown.set(false);
    this.onRepoLlmChange(llmSettingId);
  }

  onRepoLlmChange(llmSettingId: string | null): void {
    const repo = this.repository();
    if (!repo) return;
    this.repoLlmUpdating.set(true);
    this.repositoryService.updateRepositoryLlmSetting(repo.id, llmSettingId).subscribe({
      next: (updated) => {
        // Merge updated fields into existing repo to preserve all properties
        this.repository.set({ ...repo, ...updated });
      },
      error: () => {
        this.repoLlmUpdating.set(false);
      },
      complete: () => {
        this.repoLlmUpdating.set(false);
      }
    });
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

    if (analysisViewer) {
      console.log('Found existing analysis sandbox for this repo, reconnecting...', analysisViewer.id);

      this.analysisSandboxId.set(analysisViewer.id);
      this.analysisLoading.set(true);
      this.analysisStatus.set('Reconnecting to analysis...');

      this.resumeAnalysisPolling(analysisViewer.id);
    }
  }

  private async resumeAnalysisPolling(sandboxId: string): Promise<void> {
    const branch = this.currentBranch() || 'main';

    try {
      this.analysisStatus.set('Waiting for AI response...');
      const response = await this.waitForZedResponse(sandboxId);

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
        void this.tryRestoreCodeAskSession();
        setTimeout(() => void this.tryRestoreCodeAskSession(), 400);
      },
      error: (err) => {
        console.warn('Failed to load branches:', err);
        this.currentBranch.set(this.repository()?.defaultBranch || 'main');
        this.loadRootTree();
        void this.tryRestoreCodeAskSession();
        setTimeout(() => void this.tryRestoreCodeAskSession(), 400);
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

  setCodeMobilePane(pane: 'explorer' | 'code'): void {
    this.codeMobilePane.set(pane);
  }

  loadFileContent(path: string): void {
    const repoId = this.repositoryId();
    const branch = this.currentBranch();

    this.codeMobilePane.set('code');
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
    this.codeMobilePane.set('explorer');
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
    if (branch.name === this.currentBranch()) {
      this.showBranchDropdown.set(false);
      return;
    }
    if (this.codeChatSandboxId()) {
      const ok = confirm(
        'Switching branches will stop the running Ask sandbox and clear the in-page chat for this repository. Continue?'
      );
      if (!ok) {
        this.showBranchDropdown.set(false);
        return;
      }
    }
    this.releaseCodeChatSandbox();
    this.codeAskRestoreDoneForRepo = null;
    this.currentBranch.set(branch.name);
    this.showBranchDropdown.set(false);
    this.selectedFile.set(null);
    this.selectedFilePath.set(null);
    this.codeMobilePane.set('explorer');
    this.loadRootTree();
    void this.tryRestoreCodeAskSession();
  }

  /**
   * Router guard: leaving `/code/:id` with an active Ask sandbox requires confirmation and deletes the container.
   */
  confirmLeaveCodePage(): boolean {
    if (!this.codeChatSandboxId()) {
      return true;
    }
    const ok = confirm(
      'You have an Ask sandbox running. Leaving will stop the container and clear the in-session chat. Continue?'
    );
    if (!ok) {
      return false;
    }
    this.releaseCodeChatSandbox();
    return true;
  }

  @HostListener('window:beforeunload', ['$event'])
  protected onWindowBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.codeChatSandboxId()) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  @HostListener('window:pagehide', ['$event'])
  protected onWindowPageHide(event: PageTransitionEvent): void {
    if (event.persisted) {
      return;
    }
    const sid = this.codeChatSandboxId();
    if (!sid) {
      return;
    }
    if (this.vncViewerService.getViewer(sid)) {
      this.vncViewerService.dismissViewerKeepSandbox(sid);
    }
    this.sandboxService.requestDeleteSandboxOnUnload(sid);
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

  /** Ask tab: send message to headless agent (creates sandbox once, no desktop/VNC). */
  async sendCodeChat(): Promise<void> {
    const text = this.codeChatInput().trim();
    if (!text || this.codeChatBusy()) return;
    const repo = this.repository();
    if (!repo) return;

    this.codeChatError.set(null);
    this.codeChatLiveTools.set([]);
    this.codeChatStreamHint.set(null);
    this.codeChatBusy.set(true);
    const conversationHistoryForAgent = this.buildAgentConversationHistoryFromAskMessages(this.codeChatMessages());
    this.codeChatMessages.update(msgs => [
      ...msgs,
      { id: `u-${Date.now()}`, role: 'user', content: text }
    ]);
    this.codeChatInput.set('');

    try {
      let sid = this.codeChatSandboxId();
      if (!sid) {
        this.codeChatStatus.set('Creating sandbox…');
        const branch = this.currentBranch() || 'main';
        try {
          const clone = await firstValueFrom(this.repositoryService.getAuthenticatedCloneUrl(repo.id));
          sid = await this.bootstrapCodeChatSandbox(repo, clone.cloneUrl, branch, clone.archiveUrl ?? undefined);
        } catch {
          sid = await this.bootstrapCodeChatSandbox(repo, repo.cloneUrl, branch);
        }
        this.codeChatSandboxId.set(sid);
      }

      this.codeChatStatus.set('Sending to agent…');
      const post = await firstValueFrom(
        this.sandboxBridgeService.sendHeadlessAgentPrompt(sid, text, conversationHistoryForAgent).pipe(
          catchError(err => {
            if (err?.status === 409) {
              return of({
                status: 'error' as const,
                error: 'Another agent task is running. Wait a few seconds and try again.'
              });
            }
            throw err;
          })
        )
      );

      if (post.status !== 'ok') {
        throw new Error('error' in post && post.error ? post.error : 'Failed to start agent');
      }
      const promptId = post.prompt_id;
      if (!promptId) {
        throw new Error('Failed to start agent');
      }

      this.codeChatStatus.set('Agent is exploring the repository…');
      const conv = await this.pollForHeadlessAnswer(sid, promptId);

      const toolSummary =
        conv.tool_calls && conv.tool_calls.length > 0
          ? `Tools: ${conv.tool_calls.map(t => t.name).join(', ')}`
          : undefined;

      this.codeChatMessages.update(msgs => [
        ...msgs,
        {
          id: promptId,
          role: 'assistant',
          content: conv.assistant_message || '',
          toolCallsSummary: toolSummary
        }
      ]);
      this.codeChatStatus.set('');
      this.codeChatLiveTools.set([]);
      this.codeChatStreamHint.set(null);
      this.persistCodeAskToServer();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Request failed';
      this.codeChatError.set(msg);
      this.codeChatStatus.set('');
      this.codeChatLiveTools.set([]);
      this.codeChatStreamHint.set(null);
    } finally {
      this.codeChatBusy.set(false);
    }
  }

  private async bootstrapCodeChatSandbox(
    repo: Repository,
    cloneUrl: string,
    branch: string,
    repoArchiveUrl?: string
  ): Promise<string> {
    const sandbox = await firstValueFrom(
      this.sandboxService.createSandbox({
        repo_url: cloneUrl,
        repo_name: repo.name,
        repository_id: repo.id,
        repo_branch: branch,
        repo_archive_url: repoArchiveUrl
      })
    );
    if (!sandbox?.id) throw new Error('Sandbox ID not returned');

    this.codeChatVncPassword.set(sandbox.vnc_password);

    await this.delay(Math.min(5000, VPS_CONFIG.sandboxReadyDelayMs));
    this.codeChatStatus.set('Waiting for bridge…');
    await this.waitForCodeChatBridge(sandbox.id);
    this.codeChatSandboxOwned.set(true);
    return sandbox.id;
  }

  /**
   * Reconnect Ask: load history from Postgres, then attach running sandbox + bridge when available.
   */
  private normalizeAskBranchName(branch: string): string {
    return (branch || 'main').trim().toLowerCase();
  }

  /** Prefer the longer transcript (bridge vs DB); tie-break on bridge when same length. */
  /**
   * Prior turns sent to /agent/prompt so the headless loop matches bridge limits (6 turns, clipped).
   * Uses toolCallsSummary as assistant text when content is empty (tool-only prior turns).
   */
  private buildAgentConversationHistoryFromAskMessages(msgs: CodeAskMessage[]): ConversationMessage[] {
    const maxTurns = 6;
    const maxChars = 6000;
    const cap = maxTurns * 2;
    const out: ConversationMessage[] = [];
    for (const m of msgs) {
      if (m.role !== 'user' && m.role !== 'assistant') {
        continue;
      }
      let content = (m.content || '').trim();
      if (m.role === 'assistant' && !content && m.toolCallsSummary?.trim()) {
        content = m.toolCallsSummary.trim();
      }
      if (!content) {
        continue;
      }
      const clipped =
        content.length <= maxChars ? content : `${content.slice(0, maxChars - 24)}\n… [truncated]`;
      out.push({ role: m.role, content: clipped });
    }
    return out.length > cap ? out.slice(-cap) : out;
  }

  private mergeCodeAskMessages(db: CodeAskMessage[], bridge: CodeAskMessage[]): CodeAskMessage[] {
    if (bridge.length > db.length) {
      return bridge;
    }
    if (bridge.length === db.length && bridge.length > 0) {
      return bridge;
    }
    return db.length > 0 ? db : bridge;
  }

  private mapApiMessagesToAsk(rows: { id: string; role: string; content: string; toolCallsSummary?: string }[]): CodeAskMessage[] {
    return rows.map(m => ({
      id: m.id,
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content ?? '',
      toolCallsSummary: m.toolCallsSummary
    }));
  }

  private persistCodeAskToServer(): void {
    const repoId = this.repositoryId();
    const branch = this.currentBranch() || 'main';
    const msgs = this.codeChatMessages();
    if (!repoId || msgs.length === 0) {
      return;
    }
    this.codeAskConversationService.saveMessages(repoId, branch, msgs).subscribe({
      error: err => console.warn('Ask: could not persist conversation to server:', err)
    });
  }

  private async tryRestoreCodeAskSession(): Promise<void> {
    const repoId = this.repositoryId();
    if (!repoId) return;
    if (this.codeAskRestoreDoneForRepo === repoId) return;

    const branch = this.currentBranch() || 'main';

    const fromDb = await firstValueFrom(
      this.codeAskConversationService.getMessages(repoId, branch).pipe(catchError(() => of([])))
    );
    if (fromDb.length > 0) {
      this.codeChatMessages.set(this.mapApiMessagesToAsk(fromDb));
    }

    const session = await firstValueFrom(
      this.sandboxService.getSandboxForRepository(repoId).pipe(catchError(() => of(null)))
    );

    const finishScroll = () => {
      queueMicrotask(() => {
        this.scrollAskThreadToBottom();
        this.ensureAskThreadMutationObserver();
      });
    };

    if (!session?.id) {
      this.codeAskRestoreDoneForRepo = repoId;
      finishScroll();
      return;
    }

    const boundBranch =
      session.repo_branch ?? (session as { repoBranch?: string }).repoBranch ?? '';
    if (this.normalizeAskBranchName(boundBranch) !== this.normalizeAskBranchName(branch)) {
      this.codeAskRestoreDoneForRepo = repoId;
      finishScroll();
      return;
    }

    const status = (session.status || '').toLowerCase();
    if (status.includes('stop') || status.includes('terminat') || status === 'exited') {
      this.codeAskRestoreDoneForRepo = repoId;
      finishScroll();
      return;
    }

    try {
      const h = await firstValueFrom(this.sandboxBridgeService.health(session.id));
      if (h.status !== 'ok') {
        this.codeAskRestoreDoneForRepo = repoId;
        finishScroll();
        return;
      }
    } catch {
      this.codeAskRestoreDoneForRepo = repoId;
      finishScroll();
      return;
    }

    this.codeChatSandboxId.set(session.id);
    if (session.vnc_password) this.codeChatVncPassword.set(session.vnc_password);
    this.codeChatSandboxOwned.set(true);

    try {
      const all = await firstValueFrom(this.sandboxBridgeService.getAllConversations(session.id));
      const headless = (all.conversations || [])
        .filter(c => c.source === 'headless_agent')
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      const bridgeMsgs: CodeAskMessage[] = [];
      for (const c of headless) {
        const uid = c.id ? `u-${c.id}` : `u-${c.timestamp}`;
        bridgeMsgs.push({ id: uid, role: 'user', content: c.user_message || '' });
        const toolSummary =
          c.tool_calls && c.tool_calls.length > 0
            ? `Tools: ${c.tool_calls.map(t => t.name).join(', ')}`
            : undefined;
        bridgeMsgs.push({
          id: c.id || `a-${c.timestamp}`,
          role: 'assistant',
          content: c.assistant_message || '',
          toolCallsSummary: toolSummary
        });
      }
      const merged = this.mergeCodeAskMessages(this.codeChatMessages(), bridgeMsgs);
      this.codeChatMessages.set(merged);
      if (merged.length > 0) {
        this.persistCodeAskToServer();
      }
    } catch (e) {
      console.warn('Ask: could not load conversations from bridge:', e);
    }

    this.codeAskRestoreDoneForRepo = repoId;
    finishScroll();
  }

  /** Open the running Ask sandbox in the VNC viewer (same container as headless chat). */
  openCodeChatSandboxDesktop(): void {
    const sid = this.codeChatSandboxId();
    if (!sid) return;
    const repo = this.repository();
    const title = repo ? `${repo.name} · Ask` : `Sandbox ${sid.slice(0, 8)}`;
    this.vncViewerService.open(sid, title, undefined, this.codeChatVncPassword(), {
      hideMinimizedTray: true,
    });
    this.vncViewerService.setDockPosition(sid, 'floating');
  }

  private async waitForCodeChatBridge(sandboxId: string): Promise<void> {
    for (let i = 0; i < 90; i++) {
      try {
        const h = await firstValueFrom(this.sandboxBridgeService.health(sandboxId));
        if (h.status === 'ok') {
          await this.delay(1500);
          return;
        }
      } catch {
        /* retry */
      }
      await this.delay(2000);
    }
    throw new Error('Sandbox bridge did not become ready in time.');
  }

  private async pollForHeadlessAnswer(sandboxId: string, promptId: string): Promise<ZedConversation> {
    const maxAttempts = 600;
    for (let i = 0; i < maxAttempts; i++) {
      const all = await firstValueFrom(this.sandboxBridgeService.getAllConversations(sandboxId));
      const hp = all.headless_progress;
      if (hp?.tools?.length) {
        this.codeChatLiveTools.set(
          hp.tools.map(t => ({ name: t.name, args_preview: t.args_preview }))
        );
      }
      if (all.live_response?.content) {
        this.codeChatStreamHint.set(all.live_response.content);
      } else if (hp?.tools?.length) {
        const last = hp.tools[hp.tools.length - 1];
        this.codeChatStreamHint.set(last?.name ? `Running: ${last.name}` : null);
      }

      const hit = all.conversations.find(c => c.id === promptId);
      const body = hit?.assistant_message?.trim();
      if (body) {
        return hit!;
      }

      const running = await firstValueFrom(this.sandboxBridgeService.getAgentRunningStatus(sandboxId));
      if (!running.running && i > 8 && !body) {
        throw new Error('Agent finished without a recorded answer. Try again or check sandbox logs.');
      }

      await this.delay(400);
    }
    throw new Error('Timed out waiting for the agent.');
  }

  onCodeChatEnter(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter' || ev.shiftKey) return;
    ev.preventDefault();
    void this.sendCodeChat();
  }

  private detachAskViewerIfOpen(sandboxId: string): void {
    if (this.vncViewerService.getViewer(sandboxId)) {
      this.vncViewerService.dismissViewerKeepSandbox(sandboxId);
    }
  }

  private releaseCodeChatSandbox(): void {
    const sid = this.codeChatSandboxId();
    if (sid) {
      this.detachAskViewerIfOpen(sid);
      this.sandboxService.deleteSandbox(sid).subscribe({
        error: err => console.warn('Code chat sandbox cleanup:', err)
      });
    }
    this.codeChatSandboxId.set(null);
    this.codeChatVncPassword.set(undefined);
    this.codeChatSandboxOwned.set(false);
    this.codeChatMessages.set([]);
    this.codeChatStatus.set('');
    this.codeChatError.set(null);
    this.codeChatLiveTools.set([]);
    this.codeChatStreamHint.set(null);
  }

  formatFileSize(size?: number): string {
    if (!size) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  goBack(): void {
    void this.router.navigate(['/repositories']);
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
    if (tab === 'ask') {
      void this.tryRestoreCodeAskSession();
      setTimeout(() => {
        this.scrollAskThreadToBottom();
        this.ensureAskThreadMutationObserver();
      }, 0);
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

    this.analysisLoading.set(true);
    this.analysisError.set(null);
    this.analysisStatus.set('Checking AI configuration...');

    this.analysisStatus.set('Creating sandbox...');
    this.repositoryService.getAuthenticatedCloneUrl(repo.id).subscribe({
      next: (result) => {
        this.createAnalysisSandbox(repo, result.cloneUrl, branch, result.archiveUrl);
      },
      error: (err) => {
        console.error('Failed to get authenticated clone URL:', err);
        this.createAnalysisSandbox(repo, repo.cloneUrl, branch);
      }
    });
  }

  private createAnalysisSandbox(repo: Repository, cloneUrl: string, branch: string, repoArchiveUrl?: string): void {
    this.sandboxService.createSandbox({
      repo_url: cloneUrl,
      repo_name: repo.name,
      repo_branch: branch,
      repo_archive_url: repoArchiveUrl,
    }).subscribe({
      next: (sandbox) => {
        this.analysisSandboxId.set(sandbox.id);
        this.analysisStatus.set('Waiting for environment...');

        setTimeout(() => {
          this.vncViewerService.open(
            sandbox.id,
            `${repo.name} - Analysis`,
            {
              repositoryId: this.repositoryId(),
              repositoryFullName: repo.fullName || repo.name,
              defaultBranch: branch,
              storyTitle: 'Code Analysis',
              storyId: `analysis-${this.repositoryId()}`
            },
            sandbox.vnc_password
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
    if (!sandbox.id) {
      this.analysisError.set('Sandbox ID not available');
      this.analysisLoading.set(false);
      this.cleanupAnalysisSandbox();
      return;
    }

    const sid = sandbox.id;
    try {
      this.analysisStatus.set('Waiting for Zed IDE...');
      await this.waitForZedReady(sid);

      this.analysisStatus.set('Analyzing repository...');
      const prompt = this.buildAnalysisPrompt(repoName);
      await this.sendPromptToZed(sid, prompt);

      this.analysisStatus.set('Waiting for AI response...');
      const response = await this.waitForZedResponse(sid);

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

  private async waitForZedReady(sandboxId: string, maxAttempts = 60): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await firstValueFrom(
          this.sandboxBridgeService.health(sandboxId)
        );
        if (response.status === 'ok') {
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

  private async sendPromptToZed(sandboxId: string, prompt: string): Promise<void> {
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`Retrying analysis prompt (attempt ${attempt + 1}/${maxRetries}) in 15s...`);
          await this.delay(15000);
        }
        await firstValueFrom(
          this.sandboxBridgeService.sendZedPrompt(sandboxId, prompt)
        );
        console.log('Analysis prompt sent successfully');
        return;
      } catch (err) {
        console.warn(`Analysis prompt attempt ${attempt + 1} failed:`, err);
        if (attempt + 1 >= maxRetries) {
          throw new Error('Failed to send analysis prompt after multiple retries');
        }
      }
    }
  }

  private async waitForZedResponse(sandboxId: string, maxAttempts = 600): Promise<string> {
    // 600 attempts * 2 seconds = 20 minutes max wait time for comprehensive analysis
    let lastMessageLength = 0;
    let stableCount = 0;
    let initialConversationId: string | null = null;

    // First, get the current conversation ID to detect new responses
    try {
      const initial = await firstValueFrom(
        this.sandboxBridgeService.getLatestZedConversation(sandboxId)
      );
      if (initial) {
        initialConversationId = initial.id;
      }
    } catch {
      // No existing conversation
    }

    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await firstValueFrom(
          this.sandboxBridgeService.getLatestZedConversation(sandboxId)
        );

        consecutiveErrors = 0;

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
        consecutiveErrors++;
        console.warn(`Error polling Zed conversation (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error('Sandbox connection lost — the container may have been stopped.');
        }
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
