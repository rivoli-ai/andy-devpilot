import {
  Component,
  OnInit,
  OnDestroy,
  HostListener,
  signal,
  computed,
  viewChild,
  ElementRef,
  effect,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
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
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';

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
  private readonly sanitizer = inject(DomSanitizer);

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
  /** True while a user-triggered full-repo analysis run is in flight (not the loadAnalysis() fetch). */
  analysisRunActive = signal<boolean>(false);
  analysisError = signal<string | null>(null);
  analysisSandboxId = signal<string | null>(null);
  analysisStatus = signal<string>('');
  /** Live tool steps from bridge headless_progress during repository analysis. */
  analysisLiveTools = signal<
    { name: string; args_preview?: string; result_preview?: string; at?: number }[]
  >([]);
  /** Full partial assistant text from live_response while the model streams. */
  analysisLiveStream = signal<string>('');
  analysisBridgeRequestInProgress = signal<boolean>(false);

  readonly analysisLiveProgressScroll = viewChild<ElementRef<HTMLElement>>('analysisLiveProgressScroll');

  private analysisLiveScrollRaf = 0;

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

  /** Dev-server port for Ask app preview; null until the user picks one (iframe stays empty). */
  codeAskPreviewPort = signal<number | null>(null);
  /** When true, split Ask into two columns: chat left, sandbox app preview right. */
  codeAskPreviewEmbedded = signal<boolean>(false);
  /** Custom port dropdown (same pattern as branch selector). */
  showCodeAskPreviewPortDropdown = signal<boolean>(false);
  /** Free-form port input backing value for the dropdown's text field. */
  codeAskPreviewPortInput = signal<string>('');
  /** Transient validation message for the port field. */
  codeAskPreviewPortError = signal<string | null>(null);

  /** Ports blocked by the proxy (keep in sync with DENIED_PREVIEW_PORTS on the backend / manager). */
  private readonly codeAskPreviewDeniedPorts: ReadonlySet<number> = new Set([
    0, 22, 25, 111, 135, 139, 445, 389, 636, 1433, 3306, 5432,
    5900, 6379, 6080, 6081, 8090, 8091, 9042, 11211, 27017
  ]);

  /** Common dev-server ports shown as quick-pick suggestions (any other port works too). */
  readonly codeAskPreviewPortOptions: readonly number[] = [
    3000, 3001, 4173, 4200, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000
  ];

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

  /** Safe URL for split-view preview iframe (null until port is chosen or column hidden). */
  askPreviewSafeUrl = computed((): SafeResourceUrl | null => {
    if (!this.codeAskPreviewEmbedded()) return null;
    const sid = this.codeChatSandboxId();
    if (!sid) return null;
    const port = this.codeAskPreviewPort();
    if (port == null) return null;
    const raw = this.sandboxBridgeService.buildPreviewUrl(sid, port);
    return this.sanitizer.bypassSecurityTrustResourceUrl(raw);
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private repositoryService: RepositoryService,
    private sandboxService: SandboxService,
    private aiConfigService: AIConfigService,
    private vncViewerService: VncViewerService,
    private sandboxBridgeService: SandboxBridgeService,
    private codeAskConversationService: CodeAskConversationService,
    private confirmDialog: ConfirmDialogService,
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
        this.showCodeAskPreviewPortDropdown.set(false);
        this.teardownAskThreadMutationObserver();
        return;
      }
      queueMicrotask(() => {
        this.scrollAskThreadToBottom();
        this.ensureAskThreadMutationObserver();
      });
    });

    effect(() => {
      if (!this.analysisRunActive() || !this.analysisLoading()) {
        return;
      }
      this.analysisLiveStream();
      this.analysisLiveTools();
      queueMicrotask(() => this.queueAnalysisLiveScrollToEnd());
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
    if (this.analysisLiveScrollRaf) {
      cancelAnimationFrame(this.analysisLiveScrollRaf);
      this.analysisLiveScrollRaf = 0;
    }
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
    } else {
      this.error.set('Repository ID is required');
    }
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

  async selectBranch(branch: RepositoryBranch): Promise<void> {
    if (branch.name === this.currentBranch()) {
      this.showBranchDropdown.set(false);
      return;
    }
    const ask = !!this.codeChatSandboxId();
    const analyzing = this.analysisRunActive();
    if (ask || analyzing) {
      let message: string;
      if (ask && analyzing) {
        message =
          'Switching branches will stop the running Ask sandbox, cancel in-progress repository analysis, and clear the in-page chat. Continue?';
      } else if (ask) {
        message =
          'Switching branches will stop the running Ask sandbox and clear the in-page chat for this repository. Continue?';
      } else {
        message =
          'Switching branches will cancel in-progress repository analysis and remove its temporary sandbox. Continue?';
      }
      const ok = await this.confirmDialog.confirm({
        title: 'Switch branch?',
        message,
        confirmText: 'Switch branch',
        cancelText: 'Cancel',
        variant: 'danger'
      });
      if (!ok) {
        this.showBranchDropdown.set(false);
        return;
      }
    }
    this.cancelActiveRepositoryAnalysisRun();
    this.releaseCodeChatSandbox();
    this.codeAskRestoreDoneForRepo = null;
    this.currentBranch.set(branch.name);
    this.showBranchDropdown.set(false);
    this.selectedFile.set(null);
    this.selectedFilePath.set(null);
    this.codeMobilePane.set('explorer');
    this.loadRootTree();
    void this.tryRestoreCodeAskSession();
    if (this.activeTab() === 'analysis') {
      this.loadAnalysis();
    } else {
      this.analysisResult.set(null);
      this.analysisError.set(null);
    }
  }

  /**
   * Router guard: leaving `/code/:id` with an active Ask sandbox or in-progress repository analysis
   * requires confirmation and tears down sandboxes.
   */
  async confirmLeaveCodePage(): Promise<boolean> {
    const ask = !!this.codeChatSandboxId();
    const analyzing = this.analysisRunActive();
    if (!ask && !analyzing) {
      return true;
    }
    let message: string;
    if (ask && analyzing) {
      message =
        'You have an Ask sandbox running and repository analysis in progress. Leaving will stop both and clear the in-session chat.';
    } else if (ask) {
      message =
        'You have an Ask sandbox running. Leaving will stop the container and clear the in-session chat.';
    } else {
      message =
        'Repository analysis is still running. Leaving will cancel it and remove the temporary sandbox.';
    }
    const ok = await this.confirmDialog.confirm({
      title: 'Leave this page?',
      message,
      confirmText: 'Leave',
      cancelText: 'Stay',
      variant: 'danger'
    });
    if (!ok) {
      return false;
    }
    this.cancelActiveRepositoryAnalysisRun();
    this.releaseCodeChatSandbox();
    return true;
  }

  @HostListener('window:beforeunload', ['$event'])
  protected onWindowBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.codeChatSandboxId() || this.analysisRunActive()) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  @HostListener('window:pagehide', ['$event'])
  protected onWindowPageHide(event: PageTransitionEvent): void {
    if (event.persisted) {
      return;
    }
    const askSid = this.codeChatSandboxId();
    if (askSid) {
      if (this.vncViewerService.getViewer(askSid)) {
        this.vncViewerService.dismissViewerKeepSandbox(askSid);
      }
      this.sandboxService.requestDeleteSandboxOnUnload(askSid);
    }
    const analysisSid = this.analysisSandboxId();
    if (analysisSid) {
      this.sandboxService.requestDeleteSandboxOnUnload(analysisSid);
    }
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

  /** Open proxied dev-server preview in a new tab (e.g. after agent runs `npm run dev`). */
  openCodeAskPreviewInNewTab(): void {
    const sid = this.codeChatSandboxId();
    const port = this.codeAskPreviewPort();
    if (!sid || port == null) return;
    const url = this.sandboxBridgeService.buildPreviewUrl(sid, port);
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  /** Same preview URL in a separate window (user preference vs. a normal tab). */
  openCodeAskPreviewPopOut(): void {
    const sid = this.codeChatSandboxId();
    const port = this.codeAskPreviewPort();
    if (!sid || port == null) return;
    const url = this.sandboxBridgeService.buildPreviewUrl(sid, port);
    const w = Math.min(1280, Math.max(800, window.screen.availWidth - 96));
    const h = Math.min(860, Math.max(560, window.screen.availHeight - 96));
    const name = `devpilot-preview-${sid.slice(0, 8)}`;
    const features = `popup=yes,width=${w},height=${h},left=${Math.max(0, Math.floor((window.screen.availWidth - w) / 2))},top=${Math.max(0, Math.floor((window.screen.availHeight - h) / 2))},menubar=no,toolbar=no`;
    window.open(url, name, features);
  }

  toggleCodeAskPreviewEmbedded(): void {
    this.codeAskPreviewEmbedded.update(v => {
      const next = !v;
      if (next) {
        this.codeAskPreviewPort.set(null);
        this.codeAskPreviewPortInput.set('');
        this.codeAskPreviewPortError.set(null);
      }
      this.showCodeAskPreviewPortDropdown.set(false);
      return next;
    });
  }

  toggleCodeAskPreviewPortDropdown(): void {
    this.showCodeAskPreviewPortDropdown.update(open => {
      const next = !open;
      if (next) {
        this.codeAskPreviewPortInput.set(String(this.codeAskPreviewPort() ?? ''));
        this.codeAskPreviewPortError.set(null);
      }
      return next;
    });
  }

  selectCodeAskPreviewPort(port: number): void {
    this.codeAskPreviewPort.set(port);
    this.codeAskPreviewPortInput.set(String(port));
    this.codeAskPreviewPortError.set(null);
    this.showCodeAskPreviewPortDropdown.set(false);
  }

  /** Apply the free-form port from the dropdown input (Enter / Apply button). */
  applyCustomCodeAskPreviewPort(): void {
    const raw = this.codeAskPreviewPortInput().trim();
    if (!raw) {
      this.codeAskPreviewPortError.set('Enter a port number.');
      return;
    }
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.codeAskPreviewPortError.set('Port must be a whole number between 1 and 65535.');
      return;
    }
    if (this.codeAskPreviewDeniedPorts.has(port)) {
      this.codeAskPreviewPortError.set(
        `Port ${port} is reserved for an internal service and cannot be previewed.`);
      return;
    }
    this.selectCodeAskPreviewPort(port);
  }

  onCodeAskPreviewPortKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.applyCustomCodeAskPreviewPort();
    } else if (event.key === 'Escape') {
      this.showCodeAskPreviewPortDropdown.set(false);
    }
  }

  /**
   * Clear all Ask messages for the current branch: UI, persisted snapshot, and bridge history when connected.
   */
  async clearCodeAskHistory(): Promise<void> {
    if (this.codeChatBusy()) {
      return;
    }
    if (this.codeChatMessages().length === 0) {
      return;
    }
    const ok = await this.confirmDialog.confirm({
      title: 'Clear chat history?',
      message:
        'Clear all messages in this chat for the current branch? Saved history will be removed and the sandbox conversation reset if a session is running.',
      confirmText: 'Clear history',
      cancelText: 'Cancel',
      variant: 'danger'
    });
    if (!ok) {
      return;
    }

    const repoId = this.repositoryId();
    const branch = this.currentBranch() || 'main';
    const sid = this.codeChatSandboxId();

    this.codeChatMessages.set([]);
    this.codeChatError.set(null);
    this.codeChatStatus.set('');
    this.codeChatLiveTools.set([]);
    this.codeChatStreamHint.set(null);

    this.codeAskConversationService.saveMessages(repoId, branch, []).subscribe({
      next: () => {
        queueMicrotask(() => this.scrollAskThreadToBottom());
      },
      error: err => console.warn('Ask: could not clear persisted conversation:', err)
    });

    if (sid) {
      this.sandboxBridgeService.clearHistory(sid).subscribe({
        error: err => console.warn('Ask: could not clear bridge history:', err)
      });
    }
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
      // Check running FIRST. The bridge appends the conversation entry then
      // flips _agent_running to false, so reading conversations AFTER we
      // observed running=false guarantees we see the final write.
      const running = await firstValueFrom(this.sandboxBridgeService.getAgentRunningStatus(sandboxId));

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

      if (!running.running && i > 8) {
        // Grace re-check: the append may have happened between the two
        // HTTP reads above, or the bridge may still be flushing.
        await this.delay(800);
        const finalAll = await firstValueFrom(this.sandboxBridgeService.getAllConversations(sandboxId));
        const finalHit = finalAll.conversations.find(c => c.id === promptId);
        const finalBody = finalHit?.assistant_message?.trim();
        if (finalBody) {
          return finalHit!;
        }
        if (finalHit) {
          throw new Error('Agent finished but returned an empty answer. Try rephrasing your prompt.');
        }
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
    this.codeAskPreviewEmbedded.set(false);
    this.codeAskPreviewPort.set(null);
    this.codeAskPreviewPortInput.set('');
    this.codeAskPreviewPortError.set(null);
    this.showCodeAskPreviewPortDropdown.set(false);
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
    this.analysisResult.set(null);

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
        this.analysisResult.set(null);
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

    this.analysisRunActive.set(true);
    this.analysisLoading.set(true);
    this.analysisError.set(null);
    this.clearAnalysisLiveTelemetry();
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
    // Ephemeral sandbox only (no repository_id) so Code Ask bindings are not overwritten.
    this.sandboxService
      .createSandbox({
        repo_url: cloneUrl,
        repo_name: repo.name,
        repo_branch: branch,
        repo_archive_url: repoArchiveUrl
      })
      .subscribe({
        next: sandbox => {
          this.analysisSandboxId.set(sandbox.id);
          this.analysisStatus.set('Starting sandbox…');
          void this.runHeadlessRepositoryAnalysis(sandbox, repo.name, branch);
        },
        error: err => {
          console.error('Failed to create sandbox:', err);
          this.analysisError.set('Failed to create analysis environment');
          this.analysisRunActive.set(false);
          this.analysisLoading.set(false);
          this.clearAnalysisLiveTelemetry();
        }
      });
  }

  /** Full-repo analysis via headless ACP-style `/agent/prompt` (same path as Ask; no VNC). */
  private async runHeadlessRepositoryAnalysis(
    sandbox: CreateSandboxResponse,
    repoName: string,
    branch: string
  ): Promise<void> {
    if (!sandbox.id) {
      this.analysisError.set('Sandbox ID not available');
      this.analysisRunActive.set(false);
      this.analysisLoading.set(false);
      this.clearAnalysisLiveTelemetry();
      this.cleanupAnalysisSandbox();
      return;
    }

    const sid = sandbox.id;
    try {
      this.analysisStatus.set('Waiting for environment…');
      await this.delay(Math.min(5000, VPS_CONFIG.sandboxReadyDelayMs));
      await this.waitForZedReady(sid);

      this.analysisStatus.set('Analyzing repository…');
      const prompt = this.buildAnalysisPrompt(repoName);
      const post = await firstValueFrom(
        this.sandboxBridgeService.sendHeadlessAgentPrompt(sid, prompt).pipe(
          catchError(err => {
            if (err?.status === 409) {
              return of({
                status: 'error' as const,
                error: 'Another agent task is running in this sandbox. Try again in a few seconds.'
              });
            }
            throw err;
          })
        )
      );

      if (post.status !== 'ok') {
        throw new Error('error' in post && post.error ? post.error : 'Failed to start analysis');
      }
      const promptId = post.prompt_id;
      if (!promptId) {
        throw new Error('Failed to start analysis');
      }

      this.analysisStatus.set('Waiting for AI response…');
      const response = await this.pollForHeadlessAnalysisAnswer(sid, promptId);

      this.analysisStatus.set('Saving results…');
      this.repositoryService
        .saveCodeAnalysis(this.repositoryId(), {
          branch,
          summary: response,
          model: 'headless-agent'
        })
        .subscribe({
          next: result => {
            this.clearAnalysisLiveTelemetry();
            this.analysisResult.set(result);
            this.analysisRunActive.set(false);
            this.analysisLoading.set(false);
            this.analysisStatus.set('');
            this.cleanupAnalysisSandbox();
          },
          error: err => {
            console.error('Failed to save analysis:', err);
            this.analysisError.set('Failed to save analysis results');
            this.analysisRunActive.set(false);
            this.analysisLoading.set(false);
            this.clearAnalysisLiveTelemetry();
            this.cleanupAnalysisSandbox();
          }
        });
    } catch (err: unknown) {
      console.error('Analysis failed:', err);
      this.analysisError.set(err instanceof Error ? err.message : 'Analysis failed');
      this.analysisRunActive.set(false);
      this.analysisLoading.set(false);
      this.clearAnalysisLiveTelemetry();
      this.cleanupAnalysisSandbox();
    }
  }

  private async pollForHeadlessAnalysisAnswer(sandboxId: string, promptId: string): Promise<string> {
    const maxAttempts = 3000;
    for (let i = 0; i < maxAttempts; i++) {
      const running = await firstValueFrom(this.sandboxBridgeService.getAgentRunningStatus(sandboxId));

      const all = await firstValueFrom(this.sandboxBridgeService.getAllConversations(sandboxId));
      this.analysisBridgeRequestInProgress.set(!!all.request_in_progress);

      const hp = all.headless_progress;
      if (hp?.tools?.length) {
        this.analysisLiveTools.set(
          hp.tools.map((t: Record<string, unknown>) => this.normalizeHeadlessToolEntry(t))
        );
      }

      const stream = all.live_response?.content;
      if (stream != null && stream.length > 0) {
        this.analysisLiveStream.set(stream);
      }

      this.queueAnalysisLiveScrollToEnd();

      const hit = all.conversations.find(c => c.id === promptId);
      const body = hit?.assistant_message?.trim();
      if (body) {
        return body;
      }

      if (!running.running && i > 8) {
        await this.delay(800);
        const finalAll = await firstValueFrom(this.sandboxBridgeService.getAllConversations(sandboxId));
        const finalHit = finalAll.conversations.find(c => c.id === promptId);
        const finalBody = finalHit?.assistant_message?.trim();
        if (finalBody) {
          return finalBody;
        }
        if (finalHit) {
          throw new Error('Agent finished but returned an empty answer. Try rephrasing your prompt.');
        }
        throw new Error('Agent finished without a recorded answer. Try again or check sandbox logs.');
      }

      await this.delay(400);
    }
    throw new Error('Analysis timed out. Please try again.');
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
    throw new Error('Sandbox bridge did not become ready in time');
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
      this.sandboxService.deleteSandbox(sandboxId).subscribe({
        next: () => console.log('Analysis sandbox cleaned up'),
        error: (err) => console.warn('Failed to cleanup sandbox:', err)
      });
      this.analysisSandboxId.set(null);
    }
  }

  private clearAnalysisLiveTelemetry(): void {
    this.analysisLiveTools.set([]);
    this.analysisLiveStream.set('');
    this.analysisBridgeRequestInProgress.set(false);
  }

  /** Bridge uses snake_case; tolerate camelCase or raw argument objects. */
  private normalizeHeadlessToolEntry(raw: Record<string, unknown>): {
    name: string;
    args_preview?: string;
    result_preview?: string;
    at?: number;
  } {
    const asText = (v: unknown): string | undefined => {
      if (v == null) {
        return undefined;
      }
      if (typeof v === 'string') {
        return v;
      }
      if (typeof v === 'object') {
        try {
          return JSON.stringify(v, null, 2);
        } catch {
          return String(v);
        }
      }
      return String(v);
    };

    const nameRaw = raw['name'] ?? raw['tool_name'];
    const name =
      typeof nameRaw === 'string' && nameRaw.trim().length > 0 ? nameRaw.trim() : 'tool';

    const argsRaw = raw['args_preview'] ?? raw['argsPreview'] ?? raw['arguments'];
    const resultRaw = raw['result_preview'] ?? raw['resultPreview'] ?? raw['result'];
    const atRaw = raw['at'];

    return {
      name,
      args_preview: asText(argsRaw),
      result_preview: asText(resultRaw),
      at: typeof atRaw === 'number' ? atRaw : undefined
    };
  }

  /**
   * Pretty-print JSON tool args/results when the bridge sends JSON; otherwise show raw text.
   * Used so shell commands, paths, and file edits are readable in the analysis live panel.
   */
  formatAnalysisTelemetryText(raw: string | undefined | null): string {
    if (raw == null) {
      return '';
    }
    const t = raw.trim();
    if (!t) {
      return '';
    }
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      return raw;
    }
  }

  /** After Angular paints, pin tool list + model stream to the latest content. */
  private queueAnalysisLiveScrollToEnd(): void {
    if (this.analysisLiveScrollRaf) {
      cancelAnimationFrame(this.analysisLiveScrollRaf);
    }
    this.analysisLiveScrollRaf = requestAnimationFrame(() => {
      this.analysisLiveScrollRaf = requestAnimationFrame(() => {
        this.analysisLiveScrollRaf = 0;
        const progressEl = this.analysisLiveProgressScroll()?.nativeElement;
        if (progressEl) {
          progressEl.scrollTop = progressEl.scrollHeight;
        }
      });
    });
  }

  /** Stops an in-flight user-triggered analysis run and deletes its sandbox (no-op if not active). */
  private cancelActiveRepositoryAnalysisRun(): void {
    if (!this.analysisRunActive()) {
      return;
    }
    this.analysisRunActive.set(false);
    this.analysisLoading.set(false);
    this.analysisStatus.set('');
    this.analysisError.set(null);
    this.clearAnalysisLiveTelemetry();
    this.cleanupAnalysisSandbox();
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
