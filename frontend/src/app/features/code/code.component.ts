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
import { ButtonComponent } from '../../shared/components';

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
  imports: [CommonModule, FormsModule, RouterLink, CodeHighlightPipe, MarkdownPipe, ButtonComponent],
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

  /** Unpublished: add text file to server-stored local workspace */
  showUnpublishedAddModal = signal(false);
  unpublishedNewFilePath = signal('');
  unpublishedNewFileBody = signal('');
  unpublishedFileSaving = signal(false);

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
  /** If true, this sandbox was created for Ask; deleted only on explicit teardown / leave, not on branch switch. */
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
  /**
   * Optional sub-path appended to the preview URL (e.g. "/login", "app/dashboard?x=1").
   * Kept as the raw user string while editing; normalized when the URL is built.
   */
  codeAskPreviewPath = signal<string>('');
  /**
   * Last-applied path (the one actually loaded in the iframe). Mutating the text
   * field above shouldn't reload the iframe on every keystroke — we only reload
   * when the user hits Enter, clicks Go, or picks a new port.
   */
  codeAskPreviewAppliedPath = signal<string>('');
  /**
   * Bumped on embedded preview refresh so the iframe `src` changes and reloads.
   */
  private readonly codeAskPreviewReloadNonce = signal(0);
  /**
   * When true (with split preview on), the preview column gets most of the width and
   * the iframe a tall min-height for a “big view” without leaving the app.
   */
  codeAskPreviewBigView = signal(false);
  /** Wrapper around the preview iframe; used for browser fullscreen. */
  private readonly askPreviewFrameHost = viewChild<ElementRef<HTMLElement>>('codeAskPreviewFrameWrap');

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
  /**
   * Bumped when Ask UI is cleared (e.g. branch switch). In-flight `tryRestoreCodeAskSession` must
   * not reattach a sandbox (and repopulate the global header) after the user has moved on.
   */
  private codeAskRestoreGeneration = 0;

  /** Set while pushing Ask sandbox to local zip or to a new remote branch. */
  askPushBusy = signal<boolean>(false);
  askPushFeedback = signal<{ type: 'success' | 'error'; message: string } | null>(null);
  /** User requested stop while the headless agent is running. */
  private codeAskStopRequested = false;
  /** Set after `/agent/prompt` returns so we can resolve partial output on user stop. */
  private lastCodeAskPromptId: string | null = null;

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
    const raw = this.buildCodeAskPreviewUrl(sid, port, this.codeAskPreviewAppliedPath());
    const bust = this.codeAskPreviewReloadNonce();
    const withBust = this.appendPreviewQueryParam(raw, '__dpPreview', String(bust));
    return this.sanitizer.bypassSecurityTrustResourceUrl(withBust);
  });

  /**
   * Build a preview URL with an optional sub-path. Keeps the trailing `/` on the
   * base so sandboxed dev servers (Angular/Vite) resolve relative assets correctly,
   * then appends the user-provided path segment (leading `/` is stripped).
   */
  private buildCodeAskPreviewUrl(sandboxId: string, port: number, subPath: string): string {
    const base = this.sandboxBridgeService.buildPreviewUrl(sandboxId, port);
    const trimmed = (subPath || '').trim();
    if (!trimmed) return base;
    const hasQueryOrHash = trimmed.startsWith('?') || trimmed.startsWith('#');
    const normalized = hasQueryOrHash ? trimmed : trimmed.replace(/^\/+/, '');
    return `${base}${normalized}`;
  }

  /**
   * Add a query param to a preview URL without breaking an existing `?` / `#` structure.
   */
  private appendPreviewQueryParam(url: string, key: string, value: string): string {
    const sep = (s: string) => (s.includes('?') ? '&' : '?') + key + '=' + encodeURIComponent(value);
    const hashIdx = url.indexOf('#');
    if (hashIdx === -1) {
      return url + sep(url);
    }
    const before = url.slice(0, hashIdx);
    return before + sep(before) + url.slice(hashIdx);
  }

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

    // Navbar: headless Code → Ask sandboxes + repo name for the running list.
    effect(() => {
      const sid = this.codeChatSandboxId();
      const repo = this.repository();
      if (!sid) {
        this.sandboxService.setCodeAskActiveSandboxId(null);
        return;
      }
      this.sandboxService.setCodeAskActiveSandboxId(sid);
      this.sandboxService.setCodeAskActiveRepositoryLabel(
        this.repositoryLabelForAskNavbar(repo)
      );
    });

    this.sandboxService.releaseCodeChatRequest$
      .pipe(takeUntil(this.destroy$))
      .subscribe(id => {
        if (this.codeChatSandboxId() === id) {
          this.releaseCodeChatSandbox();
        }
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
    this.sandboxService.setCodeAskActiveSandboxId(null);
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

  openUnpublishedAddFileModal(): void {
    this.unpublishedNewFilePath.set('src/example.ts');
    this.unpublishedNewFileBody.set('// Add your code here\n');
    this.error.set(null);
    this.showUnpublishedAddModal.set(true);
  }

  closeUnpublishedAddFileModal(): void {
    this.showUnpublishedAddModal.set(false);
    this.unpublishedFileSaving.set(false);
  }

  submitUnpublishedAddFile(): void {
    const path = this.unpublishedNewFilePath().trim();
    const id = this.repositoryId();
    if (!path) return;
    this.unpublishedFileSaving.set(true);
    this.error.set(null);
    this.repositoryService.putUnpublishedFile(id, path, this.unpublishedNewFileBody()).subscribe({
      next: () => {
        this.unpublishedFileSaving.set(false);
        this.closeUnpublishedAddFileModal();
        this.loadRootTree();
        if (this.selectedFilePath() === path) {
          this.loadFileContent(path);
        }
      },
      error: (err) => {
        this.unpublishedFileSaving.set(false);
        this.error.set(err.error?.message ?? err.message ?? 'Failed to save file');
      }
    });
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
          'Switching branches will cancel in-progress repository analysis, detach the live Ask view for the branch you select, and show that branch’s saved chat. The Ask sandbox container will keep running. Continue?';
      } else if (ask) {
        message =
          'Switching branches will detach the live Ask view and show this branch’s saved chat. The running sandbox will not be stopped. Continue?';
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
    this.clearCodeChatUiStateAndOptionallyDeleteRunningSandbox(false);
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
   * Router guard for leaving `/code/:id`. The Ask sandbox is **never** torn down from here
   * (reconnect with `getSandboxForRepository` + saved chat). Only in-progress
   * **Analysis** is cancelled, and we confirm in that case.
   */
  async confirmLeaveCodePage(): Promise<boolean> {
    if (!this.analysisRunActive()) {
      return true;
    }
    const message = this.codeChatSandboxId()
      ? 'Repository analysis is in progress. Leave and cancel the analysis run? (Your Ask sandbox will keep running.)'
      : 'Repository analysis is still running. Leaving will cancel it and remove the temporary sandbox.';
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
    return true;
  }

  /**
   * Only warn on unload for in-progress **Analysis** (throwaway sandbox).
   * Do not tie this to the Ask sandbox — the Ask container is kept, and a generic
   * "leave page?" on every refresh is noisy.
   */
  @HostListener('window:beforeunload', ['$event'])
  protected onWindowBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.analysisRunActive()) {
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
      // Do not DELETE the Ask sandbox on navigation away: keep the container for when the user returns.
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
    this.lastCodeAskPromptId = null;
    this.codeAskStopRequested = false;
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
      this.lastCodeAskPromptId = promptId;

      this.codeChatStatus.set('Agent is exploring the repository…');
      const conv = await this.pollForHeadlessAnswer(sid, promptId);
      this.applyCompletedAskAssistantTurn(promptId, conv);
      this.codeChatStatus.set('');
      this.codeChatLiveTools.set([]);
      this.codeChatStreamHint.set(null);
      this.persistCodeAskToServer();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Request failed';
      if (msg === 'Stopped') {
        this.codeChatError.set(null);
        this.codeChatStatus.set('');
        const sid = this.codeChatSandboxId();
        if (sid && this.lastCodeAskPromptId) {
          await this.appendPartialAssistantAfterAskStop(sid, this.lastCodeAskPromptId);
        } else {
          this.codeChatLiveTools.set([]);
          this.codeChatStreamHint.set(null);
        }
      } else {
        this.codeChatError.set(msg);
        this.codeChatStatus.set('');
        this.codeChatLiveTools.set([]);
        this.codeChatStreamHint.set(null);
      }
    } finally {
      this.codeAskStopRequested = false;
      this.codeChatBusy.set(false);
    }
  }

  /**
   * When the user stops the run, keep visible progress: model output snapshot, tools,
   * and (if the bridge has already saved it) any assistant text — as a normal turn,
   * not a red error banner.
   */
  private async appendPartialAssistantAfterAskStop(
    sandboxId: string,
    promptId: string
  ): Promise<void> {
    const hint = (this.codeChatStreamHint() || '').trim();
    const liveTools = [...this.codeChatLiveTools()];
    let fromServer = '';
    try {
      const all = await firstValueFrom(this.sandboxBridgeService.getAllConversations(sandboxId));
      const hit = all.conversations.find(c => c.id === promptId);
      fromServer = (hit?.assistant_message || '').trim();
    } catch {
      /* use UI snapshot only */
    }
    this.codeChatLiveTools.set([]);
    this.codeChatStreamHint.set(null);

    const generic =
      fromServer === 'Stopped by user.' || fromServer === 'Stopped by user' || fromServer === '';
    let main = '';
    if (fromServer && !generic) {
      main = fromServer;
    } else if (hint) {
      main = hint;
    } else if (liveTools.length > 0) {
      main =
        'The model had not written a final answer yet. The tool steps from this run are listed below.';
    } else {
      return;
    }

    const toolSummary = liveTools.length
      ? `Tools: ${liveTools.map(t => t.name).filter(Boolean).join(', ')}`
      : undefined;

    this.codeChatMessages.update(msgs => [
      ...msgs,
      {
        id: `a-stopped-${Date.now()}`,
        role: 'assistant',
        content: main,
        toolCallsSummary: toolSummary
      }
    ]);
    this.persistCodeAskToServer();
    queueMicrotask(() => this.scrollAskThreadToBottom());
  }

  private async bootstrapCodeChatSandbox(
    repo: Repository,
    cloneUrl: string,
    branch: string,
    repoArchiveUrl?: string
  ): Promise<string> {
    const sandbox = await firstValueFrom(
      this.sandboxService.createSandbox({
        ...(cloneUrl?.trim() ? { repo_url: cloneUrl } : {}),
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
    this.codeChatStatus.set('Cloning repository…');
    await this.waitForCodeChatRepoReady(sandbox.id);
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

  /**
   * Header sandbox list: avoid leading org/owner. Azure `org/project/repo` → `project/repo`;
   * GitHub `owner/repo` and similar → `repo` only.
   */
  private repositoryLabelForAskNavbar(repo: Repository | null | undefined): string | null {
    if (!repo) {
      return null;
    }
    const nameFallback = repo.name?.trim() || null;
    const fn = repo.fullName?.trim();
    if (!fn) {
      return nameFallback;
    }
    const parts = fn
      .split('/')
      .map(p => p.trim())
      .filter(s => s.length > 0);
    if (parts.length === 0) {
      return nameFallback;
    }
    if (repo.provider === 'AzureDevOps') {
      if (parts.length >= 3) {
        return `${parts[1]}/${parts[2]}`;
      }
      if (parts.length === 2) {
        return parts[1]!;
      }
      return nameFallback;
    }
    if (parts.length === 1) {
      return parts[0]!;
    }
    if (parts.length === 2) {
      return parts[1]!;
    }
    return parts[parts.length - 1]! || nameFallback;
  }

  /**
   * Rebind `codeChatSandboxId` from the server after navigation (e.g. Code → Backlog → Code).
   * Retries when the API or bridge is briefly unavailable — do not give up on the first
   * empty binding or failed health, or returning users will look “disconnected” while the
   * container is still running.
   */
  private async tryRestoreCodeAskSession(attempt = 0): Promise<void> {
    const maxAttempts = 6;
    const restoreGen = this.codeAskRestoreGeneration;
    const isStale = (): boolean => this.codeAskRestoreGeneration !== restoreGen;

    const repoId = this.repositoryId();
    if (!repoId) {
      return;
    }
    if (this.codeChatSandboxId()) {
      this.codeAskRestoreDoneForRepo = repoId;
      return;
    }
    if (attempt === 0 && this.codeAskRestoreDoneForRepo === repoId) {
      return;
    }

    const branch = this.currentBranch() || 'main';

    const fromDb = await firstValueFrom(
      this.codeAskConversationService.getMessages(repoId, branch).pipe(catchError(() => of([])))
    );
    if (isStale()) {
      return;
    }
    if (fromDb.length > 0) {
      this.codeChatMessages.set(this.mapApiMessagesToAsk(fromDb));
    }

    const session = await firstValueFrom(
      this.sandboxService.getSandboxForRepository(repoId, branch).pipe(catchError(() => of(null)))
    );
    if (isStale()) {
      return;
    }

    const finishScroll = () => {
      queueMicrotask(() => {
        this.scrollAskThreadToBottom();
        this.ensureAskThreadMutationObserver();
      });
    };

    const scheduleRetry = (reason: 'no_session' | 'health'): void => {
      if (isStale() || this.codeChatSandboxId() || attempt >= maxAttempts) {
        return;
      }
      const delayMs = reason === 'health' ? 500 + attempt * 150 : 350 + attempt * 200;
      setTimeout(() => void this.tryRestoreCodeAskSession(attempt + 1), delayMs);
    };

    if (!session?.id) {
      finishScroll();
      if (this.codeChatSandboxId()) {
        return;
      }
      const canRetryNoSession = attempt < maxAttempts && (fromDb.length > 0 || attempt > 0);
      if (canRetryNoSession) {
        scheduleRetry('no_session');
        return;
      }
      this.codeAskRestoreDoneForRepo = repoId;
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

    let healthOk = false;
    for (let t = 0; t < 4; t++) {
      if (isStale()) {
        return;
      }
      try {
        const h = await firstValueFrom(this.sandboxBridgeService.health(session.id));
        if (h.status === 'ok') {
          healthOk = true;
          break;
        }
      } catch {
        /* retry */
      }
      await this.delay(200 * (t + 1));
    }
    if (isStale()) {
      return;
    }
    if (!healthOk) {
      finishScroll();
      if (this.codeChatSandboxId()) {
        return;
      }
      if (attempt < maxAttempts) {
        scheduleRetry('health');
        return;
      }
      this.codeAskRestoreDoneForRepo = repoId;
      return;
    }

    if (isStale()) {
      return;
    }
    this.codeChatSandboxId.set(session.id);
    if (session.vnc_password) {
      this.codeChatVncPassword.set(session.vnc_password);
    }
    this.codeChatSandboxOwned.set(true);

    try {
      const all = await firstValueFrom(this.sandboxBridgeService.getAllConversations(session.id));
      if (isStale()) {
        return;
      }
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

    if (isStale()) {
      return;
    }
    this.codeAskRestoreDoneForRepo = repoId;
    finishScroll();
    void this.resumeInFlightCodeAskIfNeeded(session.id);
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
    const url = this.buildCodeAskPreviewUrl(sid, port, this.codeAskPreviewAppliedPath());
    const t = window.open(url, '_blank', 'noopener,noreferrer');
    t?.focus();
  }

  /** Widen the preview and give the iframe a much larger share of the page (in-app, no popup). */
  toggleCodeAskPreviewBigView(): void {
    this.codeAskPreviewBigView.update(was => {
      if (was) {
        this.exitCodeAskPreviewFullscreenIfNeeded();
      }
      return !was;
    });
  }

  isCodeAskPreviewInFullscreen(): boolean {
    const el = this.askPreviewFrameHost()?.nativeElement;
    return !!el && document.fullscreenElement === el;
  }

  @HostListener('document:fullscreenchange')
  onCodeAskPreviewDocumentFullscreenChange(): void {
    /* Ensures the fullscreen toggle icon updates when the user hits Escape. */
  }

  /** Fullscreen the preview frame on the current monitor (best paired with big view). */
  toggleCodeAskPreviewFullscreen(): void {
    const el = this.askPreviewFrameHost()?.nativeElement;
    if (!el) {
      return;
    }
    if (document.fullscreenElement === el) {
      this.exitCodeAskPreviewFullscreenIfNeeded();
      return;
    }
    const req =
      el.requestFullscreen?.bind(el) ||
      (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(
        el
      );
    if (req) {
      void req();
    }
  }

  private exitCodeAskPreviewFullscreenIfNeeded(): void {
    if (!document.fullscreenElement) {
      return;
    }
    const ex =
      document.exitFullscreen?.bind(document) ||
      (document as Document & { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen?.bind(
        document
      );
    if (ex) {
      void ex();
    }
  }

  /** Reload the embedded preview iframe (full navigation). */
  refreshCodeAskPreview(): void {
    if (this.codeAskPreviewPort() == null) {
      return;
    }
    this.codeAskPreviewReloadNonce.update(n => n + 1);
  }

  toggleCodeAskPreviewEmbedded(): void {
    this.codeAskPreviewEmbedded.update(v => {
      const next = !v;
      if (next) {
        this.codeAskPreviewPort.set(null);
        this.codeAskPreviewPortInput.set('');
        this.codeAskPreviewPortError.set(null);
        this.codeAskPreviewPath.set('');
        this.codeAskPreviewAppliedPath.set('');
      } else {
        this.codeAskPreviewBigView.set(false);
        this.exitCodeAskPreviewFullscreenIfNeeded();
      }
      this.showCodeAskPreviewPortDropdown.set(false);
      return next;
    });
  }

  /** Commit the edited path (Enter / Go button): reloads the iframe. */
  applyCodeAskPreviewPath(): void {
    this.codeAskPreviewAppliedPath.set(this.codeAskPreviewPath());
  }

  /** Enter commits the path; Escape reverts to the last applied value. */
  onCodeAskPreviewPathKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.applyCodeAskPreviewPath();
    } else if (event.key === 'Escape') {
      this.codeAskPreviewPath.set(this.codeAskPreviewAppliedPath());
    }
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
    // Keep the pending text-field path but commit it now so the iframe loads the combined URL.
    this.codeAskPreviewAppliedPath.set(this.codeAskPreviewPath());
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

  /**
   * Request the running Ask headless task to end (clone wait, or agent poll).
   * Best-effort: also POSTs to the bridge stream abort endpoint.
   */
  stopAskAgent(): void {
    if (!this.codeChatBusy()) {
      return;
    }
    this.codeAskStopRequested = true;
    const sid = this.codeChatSandboxId();
    if (sid) {
      this.sandboxBridgeService.abortStream(sid).subscribe({ error: () => void 0 });
    }
  }

  askCanSaveDraftToServer(): boolean {
    return this.repository()?.provider === 'Unpublished' && !!this.codeChatSandboxId();
  }

  /** GitHub / Azure DevOps: show “push sandbox to a new remote branch” (no automatic PR). */
  askCanPushBranchFromAsk(): boolean {
    const p = this.repository()?.provider;
    return (p === 'GitHub' || p === 'AzureDevOps') && !!this.codeChatSandboxId();
  }

  private formatAskPushError(err: unknown): string {
    const http = err as {
      error?: unknown;
      message?: string;
    };
    const body = http?.error;
    if (body && typeof body === 'object') {
      const o = body as {
        error?: string;
        hint?: string;
        stderr?: string;
        stdout?: string;
        branch?: string;
      };
      if (typeof o.error === 'string' && o.error.length > 0) {
        let out = o.error;
        if (o.hint?.trim()) {
          out += ` — ${o.hint.trim()}`;
        }
        if (o.stderr?.trim()) {
          out += ` ${o.stderr.trim().slice(0, 800)}`;
        } else if (o.stdout?.trim() && /error|fatal|denied|rejected/i.test(o.stdout)) {
          out += `: ${o.stdout.trim().slice(0, 400)}`;
        }
        return out;
      }
    }
    if (typeof body === 'string' && body.length > 0) {
      return body;
    }
    if (http?.message && !/^Http failure response:/i.test(http.message)) {
      return http.message;
    }
    return 'Could not complete the operation. Check the browser network tab for the bridge response body.';
  }

  private extractCredentialsFromCloneUrl(url: string): string | undefined {
    const match = url.match(/https:\/\/([^@]+)@/);
    return match ? match[1] : undefined;
  }

  /**
   * Unpublished: zip sandbox project and import to server disk (same as VNC “save to local project”).
   */
  saveAskDraftToLocalProject(): void {
    const repo = this.repository();
    const sid = this.codeChatSandboxId();
    if (!repo || repo.provider !== 'Unpublished' || !sid) {
      return;
    }
    this.askPushBusy.set(true);
    this.askPushFeedback.set(null);
    this.sandboxBridgeService.getProjectArchiveZip(sid).subscribe({
      next: blob => {
        this.repositoryService.importUnpublishedFromZip(repo.id, blob).subscribe({
          next: r => {
            this.askPushBusy.set(false);
            this.askPushFeedback.set({
              type: 'success',
              message: r?.message || 'Local project updated.'
            });
          },
          error: err => {
            this.askPushBusy.set(false);
            this.askPushFeedback.set({ type: 'error', message: this.formatAskPushError(err) });
          }
        });
      },
      error: err => {
        this.askPushBusy.set(false);
        this.askPushFeedback.set({ type: 'error', message: this.formatAskPushError(err) });
      }
    });
  }

  /**
   * GitHub / Azure DevOps: commit Ask sandbox changes and push to a new remote branch (no PR).
   */
  pushAskToNewBranch(): void {
    const repo = this.repository();
    const sid = this.codeChatSandboxId();
    if (!repo || !sid || (repo.provider !== 'GitHub' && repo.provider !== 'AzureDevOps')) {
      return;
    }
    this.askPushBusy.set(true);
    this.askPushFeedback.set(null);

    const branchName = `devpilot-ask-${Date.now().toString(36)}`;
    const commitMessage = 'chore: changes from DevPilot Ask sandbox';

    const doPush = (creds: string | undefined) => {
      this.sandboxBridgeService
        .pushAndCreatePr(sid, {
          branchName,
          commitMessage,
          prTitle: '',
          prBody: '',
          gitCredentials: creds
        })
        .subscribe({
          next: () => {
            this.askPushBusy.set(false);
            this.askPushFeedback.set({
              type: 'success',
              message: `Pushed branch \`${branchName}\` to origin. Open your Git provider to open a pull request if you need one.`
            });
          },
          error: err => {
            this.askPushBusy.set(false);
            this.askPushFeedback.set({ type: 'error', message: this.formatAskPushError(err) });
          }
        });
    };

    this.repositoryService.getAuthenticatedCloneUrl(repo.id).subscribe({
      next: r => doPush(this.extractCredentialsFromCloneUrl(r.cloneUrl)),
      error: () => doPush(undefined)
    });
  }

  private async waitForCodeChatBridge(sandboxId: string): Promise<void> {
    for (let i = 0; i < 90; i++) {
      if (this.codeAskStopRequested) {
        throw new Error('Stopped');
      }
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

  /**
   * The bridge responds OK on /health long before the in-sandbox git clone
   * finishes. For big repositories, sending a prompt at that point makes the
   * agent see an empty project. Poll /repo-status until the clone/archive is
   * on disk, then proceed.
   *
   * Timeout is intentionally generous (~6 min): large repos on cold caches
   * and constrained egress can legitimately take several minutes to clone.
   */
  private async waitForCodeChatRepoReady(sandboxId: string): Promise<void> {
    const maxAttempts = 180;
    const pollMs = 2000;
    let lastEntriesLog = 0;
    for (let i = 0; i < maxAttempts; i++) {
      if (this.codeAskStopRequested) {
        throw new Error('Stopped');
      }
      const status = await firstValueFrom(this.sandboxBridgeService.repoStatus(sandboxId));
      if (status?.ready) {
        return;
      }
      if (status) {
        const elapsed = i * pollMs;
        if (elapsed - lastEntriesLog >= 10000) {
          lastEntriesLog = elapsed;
          const hint = status.cloned
            ? 'Repository ready, finalizing…'
            : status.setup_done
              ? 'Repository prepared, verifying files…'
              : `Cloning repository… (${Math.round(elapsed / 1000)}s)`;
          this.codeChatStatus.set(hint);
        }
      }
      await this.delay(pollMs);
    }
    throw new Error(
      'The repository is still being cloned inside the sandbox. Please wait a few seconds and try again.'
    );
  }

  /**
   * Merge or append the assistant turn after {@link pollForHeadlessAnswer} (send flow or refresh-resume).
   */
  private applyCompletedAskAssistantTurn(promptId: string, conv: ZedConversation): void {
    const toolSummary =
      conv.tool_calls && conv.tool_calls.length > 0
        ? `Tools: ${conv.tool_calls.map(t => t.name).join(', ')}`
        : undefined;
    const hasAssistant = this.codeChatMessages().some(
      m => m.id === promptId && m.role === 'assistant'
    );
    if (hasAssistant) {
      this.codeChatMessages.update(msgs =>
        msgs.map(m =>
          m.id === promptId && m.role === 'assistant'
            ? { ...m, content: conv.assistant_message || '', toolCallsSummary: toolSummary }
            : m
        )
      );
    } else {
      this.codeChatMessages.update(msgs => [
        ...msgs,
        {
          id: promptId,
          role: 'assistant',
          content: conv.assistant_message || '',
          toolCallsSummary: toolSummary
        }
      ]);
    }
  }

  /**
   * After session restore, if the bridge still has a headless agent in flight (e.g. user refreshed
   * mid-run), resume polling the same way as a live send so progress and the final answer appear.
   */
  private async resumeInFlightCodeAskIfNeeded(sandboxId: string): Promise<void> {
    if (this.codeChatBusy()) {
      return;
    }
    let st: { running: boolean; prompt_id?: string | null };
    try {
      st = await firstValueFrom(this.sandboxBridgeService.getAgentRunningStatus(sandboxId));
    } catch {
      return;
    }
    const pid = st.prompt_id?.trim();
    if (!st.running || !pid) {
      return;
    }
    this.lastCodeAskPromptId = pid;
    this.codeChatBusy.set(true);
    this.codeChatError.set(null);
    this.codeChatStatus.set('Agent still running — reconnecting…');
    this.codeAskStopRequested = false;
    try {
      const conv = await this.pollForHeadlessAnswer(sandboxId, pid);
      this.applyCompletedAskAssistantTurn(pid, conv);
      this.codeChatStatus.set('');
      this.codeChatLiveTools.set([]);
      this.codeChatStreamHint.set(null);
      this.persistCodeAskToServer();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Request failed';
      if (msg === 'Stopped') {
        this.codeChatError.set(null);
        this.codeChatStatus.set('');
        if (sandboxId && this.lastCodeAskPromptId) {
          await this.appendPartialAssistantAfterAskStop(sandboxId, this.lastCodeAskPromptId);
        } else {
          this.codeChatLiveTools.set([]);
          this.codeChatStreamHint.set(null);
        }
      } else {
        this.codeChatError.set(msg);
        this.codeChatStatus.set('');
        this.codeChatLiveTools.set([]);
        this.codeChatStreamHint.set(null);
      }
    } finally {
      this.codeAskStopRequested = false;
      this.codeChatBusy.set(false);
    }
  }

  private async pollForHeadlessAnswer(sandboxId: string, promptId: string): Promise<ZedConversation> {
    const maxAttempts = 600;
    for (let i = 0; i < maxAttempts; i++) {
      if (this.codeAskStopRequested) {
        this.sandboxBridgeService.abortStream(sandboxId).subscribe({ error: () => void 0 });
        throw new Error('Stopped');
      }
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

  /**
   * Clears Ask tab UI and the local sandbox binding. When `deleteContainer` is true, stops the
   * sandbox in the API (removes the container). When false (e.g. branch switch), the container
   * keeps running; `tryRestoreCodeAskSession` can reconnect if the user selects the matching branch again.
   */
  private clearCodeChatUiStateAndOptionallyDeleteRunningSandbox(deleteContainer: boolean): void {
    this.codeAskRestoreGeneration++;
    const sid = this.codeChatSandboxId();
    if (sid) {
      this.detachAskViewerIfOpen(sid);
      if (deleteContainer) {
        this.sandboxService.deleteSandbox(sid).subscribe({
          error: err => console.warn('Code chat sandbox cleanup:', err)
        });
      }
    }
    this.codeChatSandboxId.set(null);
    this.codeAskRestoreDoneForRepo = null;
    this.codeChatVncPassword.set(undefined);
    this.codeChatSandboxOwned.set(false);
    this.codeAskPreviewEmbedded.set(false);
    this.codeAskPreviewBigView.set(false);
    this.codeAskPreviewPort.set(null);
    this.codeAskPreviewPortInput.set('');
    this.codeAskPreviewPortError.set(null);
    this.codeAskPreviewPath.set('');
    this.codeAskPreviewAppliedPath.set('');
    this.showCodeAskPreviewPortDropdown.set(false);
    this.exitCodeAskPreviewFullscreenIfNeeded();
    this.codeChatMessages.set([]);
    this.codeChatStatus.set('');
    this.codeChatError.set(null);
    this.codeChatLiveTools.set([]);
    this.codeChatStreamHint.set(null);
  }

  private releaseCodeChatSandbox(): void {
    this.clearCodeChatUiStateAndOptionallyDeleteRunningSandbox(true);
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
        ...(cloneUrl?.trim() ? { repo_url: cloneUrl } : {}),
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
