import {
  Component,
  OnInit,
  OnDestroy,
  AfterViewInit,
  ViewChild,
  ElementRef,
  signal,
  effect,
  input,
  output,
  computed,
  HostListener,
  untracked
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml, SafeResourceUrl } from '@angular/platform-browser';
import { Subject, takeUntil, forkJoin, of, switchMap, map, catchError } from 'rxjs';
import { VncService } from '../../core/services/vnc.service';
import { VncViewerService, DockPosition } from '../../core/services/vnc-viewer.service';
import {
  SandboxBridgeService,
  SandboxStats,
  ZedConversation,
  ZedConversationsResponse,
  LiveResponse,
  SANDBOX_AGENT_QUIET_POLL_COUNT
} from '../../core/services/sandbox-bridge.service';
import { RepositoryService } from '../../core/services/repository.service';
import { BacklogService } from '../../core/services/backlog.service';
import { VncConfig, VncConnectionState, DEFAULT_VNC_CONFIG } from '../../shared/models/vnc-config.model';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe';

/** One past sandbox run for the same backlog story (from stored bridge snapshots). */
export interface PriorSandboxSessionView {
  sandboxId: string;
  createdAt: string;
  updatedAt: string | null;
  conversations: ZedConversation[];
}

/** Pinned edge for the fullscreen DevPilot toolbar (VNC + chat). */
export type FsTopBarPosition = 'top' | 'right' | 'bottom' | 'left';

/**
 * VNC Remote Desktop Viewer Component
 * Modern floating/dockable popup that displays a remote desktop via iframe
 */
@Component({
  selector: 'app-vnc-viewer',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownPipe],
  templateUrl: './vnc-viewer.component.html',
  styleUrl: './vnc-viewer.component.css'
})
export class VncViewerComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('vncIframe', { static: false }) vncIframeRef!: ElementRef<HTMLIFrameElement>;
  @ViewChild('popupContainer', { static: false }) popupContainerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('popupContent', { static: false }) popupContentRef?: ElementRef<HTMLDivElement>;
  @ViewChild('fsFullscreenBar', { static: false }) fsFullscreenBarRef?: ElementRef<HTMLDivElement>;
  @ViewChild('chatContent', { static: false }) chatContentRef?: ElementRef<HTMLDivElement>;

  // Inputs
  config = input.required<VncConfig>();
  viewerId = input<string>('');
  initialDockPosition = input<DockPosition>('floating');
  initialConnectionState = input<string | undefined>(undefined);
  initialViewMode = input<'sandbox' | 'split' | 'chat' | undefined>(undefined);
  viewerTitle = input<string>('Sandbox');
  embedded = input<boolean>(false); // When true, renders without container/header (for dock panel)
  sandboxId = input<string | undefined>(undefined);
  implementationContext = input<{
    repositoryId: string;
    repositoryFullName: string;
    defaultBranch: string;
    storyTitle: string;
    storyId: string;
    azureDevOpsWorkItemId?: number;
    repositoryProvider?: string;
  } | undefined>(undefined); // Enables Push & Create PR (or commit for Unpublished)

  // Output: Close event
  closeEvent = output<void>();

  // Internal config signal
  internalConfig = signal<VncConfig>({
    url: '',
    ...DEFAULT_VNC_CONFIG
  });

  // Connection State - Start as Connecting to avoid showing connect button
  connectionState = signal<VncConnectionState>(VncConnectionState.Connecting);
  error = signal<string | null>(null);
  connectionStateText = signal<string>('Connecting...');
  /** True after the first successful connection — prevents full-screen overlay on reconnects */
  everConnected = signal<boolean>(false);

  // UI State
  dockPosition = signal<DockPosition>('floating');
  isFullscreen = signal<boolean>(false);
  /** When true, fullscreen top bar is collapsed (show thin reveal control). */
  fsTopBarHidden = signal<boolean>(false);
  /** Fullscreen toolbar pinned to an edge of the viewer. */
  fsTopBarPosition = signal<FsTopBarPosition>('top');
  /** Degrees to rotate the collapse/expand chevrons for the current edge. */
  readonly fsTopBarChevronRotation = computed(() => {
    switch (this.fsTopBarPosition()) {
      case 'bottom':
        return 180;
      case 'right':
        return 90;
      case 'left':
        return -90;
      default:
        return 0;
    }
  });
  /** True while the user is dragging the fullscreen toolbar (Citrix-style snap on release). */
  fsToolbarDragActive = signal<boolean>(false);
  /** Top-left of toolbar relative to `.popup-content` while dragging (px). */
  fsToolbarDragLeft = signal<number>(0);
  fsToolbarDragTop = signal<number>(0);
  /**
   * After snapping to top/bottom: horizontal offset from content center (px), so the bar
   * stays where you drop it. After left/right: use {@link fsToolbarVOffset} instead.
   */
  fsToolbarHOffset = signal<number>(0);
  /** After snapping to left/right: vertical offset from content center (px). */
  fsToolbarVOffset = signal<number>(0);
  /**
   * Combined transform (edge + optional collapse) so offsets are preserved; CSS no longer
   * hard-codes `translate(-50%, …)`.
   */
  readonly fsToolbarBarTransform = computed((): string | null => {
    if (this.fsToolbarDragActive()) {
      return null;
    }
    const h = this.fsToolbarHOffset();
    const v = this.fsToolbarVOffset();
    const collapsed = this.fsTopBarHidden();
    switch (this.fsTopBarPosition()) {
      case 'top':
        return collapsed
          ? `translate(calc(-50% + ${h}px), -100%)`
          : `translateX(calc(-50% + ${h}px))`;
      case 'bottom':
        return collapsed
          ? `translate(calc(-50% + ${h}px), 100%)`
          : `translateX(calc(-50% + ${h}px))`;
      case 'right':
        return collapsed
          ? `translate(100%, calc(-50% + ${v}px))`
          : `translateY(calc(-50% + ${v}px))`;
      case 'left':
        return collapsed
          ? `translate(-100%, calc(-50% + ${v}px))`
          : `translateY(calc(-50% + ${v}px))`;
    }
  });
  showControls = signal<boolean>(true);

  private fsToolbarDragOffsetX = 0;
  private fsToolbarDragOffsetY = 0;
  private fsToolbarDragHasMoved = false;
  /** Bar size at drag start — avoids getBoundingClientRect on the bar every pointermove. */
  private fsToolbarDragBarW = 0;
  private fsToolbarDragBarH = 0;

  // Popup dimensions and position
  popupWidth = signal<number>(900);
  popupHeight = signal<number>(600);
  popupX = signal<number>(100);
  popupY = signal<number>(100);

  // Dragging state
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  // Resizing state
  private isResizing = false;
  private resizeDirection = '';
  private resizeStartWidth = 0;
  private resizeStartHeight = 0;
  private resizeStartX = 0;
  private resizeStartY = 0;

  /** Sync `isFullscreen` with the browser Fullscreen API (dock tiles need this — CSS fixed is clipped by parent backdrop-filter). */
  private readonly onFullscreenChangeBound = (): void => this.onFullscreenChange();

  // Connection timeout and retry (sandbox may take a few seconds to be ready)
  private connectionTimeout: any = null;
  private connectionRetryTimeout: any = null;
  private connectionRetryCount = 0;
  private static readonly CONNECTION_ESTABLISHED_MS = 15000; // Stay "Connecting" up to 15s before optimistic Connected
  private static readonly RETRY_DELAY_MS = 3000;           // Wait 3s before retry after error
  private static readonly MAX_CONNECTION_RETRIES = 4;     // Retry up to 4 times before showing error

  // Wait for bridge (AI conversations) before loading iframe when sandboxId is set
  private bridgeWaitIntervalId: ReturnType<typeof setInterval> | null = null;
  private static readonly BRIDGE_POLL_INTERVAL_MS = 1500;  // Poll bridge health every 1.5s
  private static readonly BRIDGE_MAX_WAIT_MS = 25000;      // Stop waiting after 25s and load iframe anyway
  /** Match backlog / VNC mobile breakpoint — agent chat sidebar is not shown on narrow viewports */
  private static readonly AGENT_CHAT_SIDEBAR_MEDIA = '(max-width: 768px)';
  private static readonly FS_TOP_BAR_POS_STORAGE_KEY = 'vncFsTopBarPos';
  private static readonly FS_TOOLBAR_OFFSETS_STORAGE_KEY = 'vncFsToolbarOffsets';

  // Conversations: current sandbox bridge poll vs earlier runs (same story) loaded from API
  conversations = signal<ZedConversation[]>([]);
  priorStorySessions = signal<PriorSandboxSessionView[]>([]);
  liveResponse = signal<LiveResponse | null>(null);
  requestInProgress = signal<boolean>(false);

  /**
   * Pre-rendered HTML for the live streaming response.
   * Throttled to avoid DOM thrashing — the markdown pipe only runs when the
   * accumulated delta exceeds a threshold or a cooldown expires, giving a
   * smooth, Zed-like incremental appearance.
   */
  liveStreamHtml = signal<SafeHtml>('');
  liveStreamRendered = signal<boolean>(false);
  private _liveRenderTimer: any = null;
  private _liveLastRenderedLen = 0;
  private static readonly LIVE_RENDER_INTERVAL_MS = 1200;
  viewMode = signal<'sandbox' | 'split' | 'chat'>('sandbox');
  showChat = computed(() => this.viewMode() === 'split' || this.viewMode() === 'chat');
  showSandbox = computed(() => this.viewMode() === 'split' || this.viewMode() === 'sandbox');
  /** False when viewport matches {@link AGENT_CHAT_SIDEBAR_MEDIA} — hide AI chat UI (desktop only) */
  agentChatSidebarAllowed = signal<boolean>(
    typeof matchMedia === 'undefined'
      ? true
      : !matchMedia(VncViewerComponent.AGENT_CHAT_SIDEBAR_MEDIA).matches
  );
  private chatSidebarMql?: MediaQueryList;
  private readonly onChatSidebarMediaChange = (): void => this.applyAgentChatSidebarAllowedFromMedia();
  chatPanelWidth = signal<number>(350);
  private chatResizing = false;
  private chatResizeStartX = 0;
  private chatResizeStartWidth = 0;
  isSending = signal<boolean>(false);
  newMessage = '';
  private destroy$ = new Subject<void>();
  private lastConversationId = '';

  /** Same quiet-period logic as {@link SandboxBridgeService.waitForImplementationComplete} */
  private pushPrQuietAccum: { stableLatestId: string | null; consecutiveStableIdle: number } = {
    stableLatestId: null,
    consecutiveStableIdle: 0
  };

  isUnpublishedImpl = computed(() => this.implementationContext()?.repositoryProvider === 'Unpublished');

  // Push & Create PR state
  pushCreatingPr = signal<boolean>(false);
  pushPrError = signal<string | null>(null);
  pushPrSuccess = signal<{ url?: string; title: string } | null>(null);

  /** Clipboard: paste from host OS into sandbox (bridge /clipboard/paste) */
  pasteFromHostBusy = signal<boolean>(false);
  pasteFromHostMessage = signal<string | null>(null);

  // Auto-reconnect state
  isReconnecting = signal<boolean>(false);
  reconnectAttempt = signal<number>(0);
  private reconnectTimeout: any = null;
  private healthCheckInterval: any = null;
  private consecutiveHealthFailures = 0;
  private static readonly HEALTH_CHECK_INTERVAL_MS = 8000;
  private static readonly RECONNECT_DELAY_MS_AUTO = 4000;
  private static readonly MAX_RECONNECT_ATTEMPTS = 15;
  private static readonly HEALTH_FAILURE_THRESHOLD = 2;

  // Stats overlay
  showStatsOverlay = signal<boolean>(false);
  sandboxStats = signal<SandboxStats | null>(null);
  private statsRefreshInterval: any = null;
  bridgeLatencyMs = signal<number>(0);

  /**
   * Enable Push PR after latest turn has assistant text and the bridge has been idle with a
   * stable latest conversation id for {@link SANDBOX_AGENT_QUIET_POLL_COUNT} polls (not only “any reply”).
   */
  canPushPrAfterQuiet = signal<boolean>(false);

  // Ready for PR state - shows alert on minimized widget
  readyForPr = signal<boolean>(false);

  // Check if this is an analysis sandbox (not a user story implementation)
  isAnalysisSandbox = computed(() => {
    const ctx = this.implementationContext();
    return ctx?.storyId?.startsWith('analysis-') ?? false;
  });

  // Check if this is a backlog generation sandbox (AI generating backlog)
  isBacklogSandbox = computed(() => {
    const ctx = this.implementationContext();
    return ctx?.storyId?.startsWith('backlog-') ?? false;
  });

  // VNC iframe URL
  private vncIframeUrlRaw = signal<string>('');

  // Check if we have a valid iframe URL
  hasIframeUrl = computed<boolean>(() => {
    const url = this.vncIframeUrlRaw();
    return url !== null && url !== undefined && url.trim() !== '';
  });

  // Simple iframe src - returns sanitized URL or about:blank
  iframeSrc = computed<SafeResourceUrl>(() => {
    const url = this.vncIframeUrlRaw();
    if (url && url.trim() !== '') {
      return this.sanitizer.bypassSecurityTrustResourceUrl(url);
    }
    return this.sanitizer.bypassSecurityTrustResourceUrl('about:blank');
  });

  // Computed styles for the popup
  popupStyle = computed(() => {
    const pos = this.dockPosition();

    if (pos === 'right') {
      return {
        width: '45%',
        height: '100%',
        right: '0',
        top: '0',
        left: 'auto',
        bottom: 'auto'
      };
    }

    if (pos === 'bottom') {
      return {
        width: '100%',
        height: '45%',
        bottom: '0',
        left: '0',
        right: 'auto',
        top: 'auto'
      };
    }

    if (pos === 'tiled') {
      return {
        width: '100%',
        height: '100%',
        left: '0',
        top: '0',
        right: 'auto',
        bottom: 'auto'
      };
    }

    // Floating (default)
    return {
      width: `${this.popupWidth()}px`,
      height: `${this.popupHeight()}px`,
      left: `${this.popupX()}px`,
      top: `${this.popupY()}px`,
      right: 'auto',
      bottom: 'auto'
    };
  });

  constructor(
    private vncService: VncService,
    private vncViewerService: VncViewerService,
    private sanitizer: DomSanitizer,
    private sandboxBridgeService: SandboxBridgeService,
    private repositoryService: RepositoryService,
    private backlogService: BacklogService,
    private markdownPipe: MarkdownPipe
  ) {
    effect(() => {
      const inputConfig = this.config();
      if (inputConfig) {
        const mergedConfig = { ...DEFAULT_VNC_CONFIG, ...inputConfig };
        this.internalConfig.set(mergedConfig);
        if (mergedConfig.url && mergedConfig.url.trim() !== '') {
          const sid = this.sandboxId();
          if (sid) {
            if (this.bridgeWaitIntervalId) {
              clearInterval(this.bridgeWaitIntervalId);
              this.bridgeWaitIntervalId = null;
            }
            this.waitForBridgeThenSetupIframe(sid);
          } else {
            this.setupIframeUrl();
          }
        }
      }
    }, { allowSignalWrites: true });

    // Update connection state text
    effect(() => {
      const state = this.connectionState();
      const stateTexts: Record<VncConnectionState, string> = {
        [VncConnectionState.Connecting]: 'Connecting...',
        [VncConnectionState.Connected]: 'Connected',
        [VncConnectionState.Disconnecting]: 'Disconnecting...',
        [VncConnectionState.Error]: 'Error',
        [VncConnectionState.Disconnected]: 'Disconnected'
      };
      this.connectionStateText.set(stateTexts[state] || 'Disconnected');
    }, { allowSignalWrites: true });

    // Initialize from service when viewer moves floating↔minimized (new component instance, same viewer)
    effect(() => {
      const init = this.initialConnectionState();
      if (init === 'connected') {
        this.connectionState.set(VncConnectionState.Connected);
      }
    }, { allowSignalWrites: true });

    // Sync connection state back to service so it persists when viewer moves floating↔minimized.
    // untracked() exits the reactive context before calling setConnectionState so that the
    // BehaviorSubject.next() it triggers does not propagate NG0600 to downstream subscribers.
    effect(() => {
      const id = this.viewerId();
      const state = this.connectionState();
      if (id && state) {
        untracked(() => this.vncViewerService.setConnectionState(id, state));
      }
    });

    // Restore viewMode from service when component re-mounts (minimize→restore)
    effect(() => {
      const init = this.initialViewMode();
      if (init) {
        this.viewMode.set(init);
      }
    }, { allowSignalWrites: true });

    // Persist viewMode back to service
    effect(() => {
      const id = this.viewerId();
      const mode = this.viewMode();
      if (id) {
        untracked(() => this.vncViewerService.setViewMode(id, mode));
      }
    });

    // When the dock mounts a new tile, viewerId can lag behind the first viewers$ emission;
    // re-pull readyForPr from the service whenever id is set.
    effect(() => {
      const id = this.viewerId();
      if (!id) return;
      untracked(() => this.syncReadyForPrFromService());
    }, { allowSignalWrites: true });

    // Auto-scroll chat to bottom when live streaming or new conversations arrive (only if chat panel is shown)
    effect(() => {
      this.liveResponse();
      this.conversations();
      this.priorStorySessions();
      if (!this.showChat()) return;
      setTimeout(() => {
        const el = this.chatContentRef?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      }, 50);
    });
  }

  /**
   * Sync readyForPr state from service
   */
  private syncReadyForPrFromService(): void {
    const id = this.viewerId();
    if (!id) return;
    const viewer = this.vncViewerService.getViewer(id);
    if (!viewer) return;
    const fromService = viewer.readyForPr === true;
    if (fromService === this.readyForPr()) return;
    this.readyForPr.set(fromService);
    if (fromService && (this.dockPosition() === 'minimized' || this.dockPosition() === 'tiled')) {
      this.playAlertSound();
    }
  }

  private waitForBridgeThenSetupIframe(sandboxId: string): void {
    const start = Date.now();
    const maxWait = VncViewerComponent.BRIDGE_MAX_WAIT_MS;
    const pollMs = VncViewerComponent.BRIDGE_POLL_INTERVAL_MS;

    const tryHealth = () => {
      if (Date.now() - start >= maxWait) {
        if (this.bridgeWaitIntervalId) {
          clearInterval(this.bridgeWaitIntervalId);
          this.bridgeWaitIntervalId = null;
        }
        console.log('Bridge wait timeout, loading VNC iframe anyway');
        this.setupIframeUrl();
        return;
      }
      this.sandboxBridgeService.health(sandboxId).subscribe({
        next: (res) => {
          if (res.status !== 'error') {
            if (this.bridgeWaitIntervalId) {
              clearInterval(this.bridgeWaitIntervalId);
              this.bridgeWaitIntervalId = null;
            }
            console.log('Bridge ready, loading VNC iframe');
            this.setupIframeUrl();
          }
        },
        error: () => { /* next poll */ }
      });
    };

    tryHealth();
    this.bridgeWaitIntervalId = setInterval(tryHealth, pollMs);
  }

  ngAfterViewInit(): void {
    this.syncReadyForPrFromService();
    document.addEventListener('fullscreenchange', this.onFullscreenChangeBound);
    document.addEventListener('webkitfullscreenchange', this.onFullscreenChangeBound as EventListener);
  }

  ngOnInit(): void {
    // Set initial dock position from input
    const initialPos = this.initialDockPosition();
    if (initialPos) {
      this.dockPosition.set(initialPos);
    }

    // Center the popup initially (only if floating and not embedded / grid-tiled)
    if (this.dockPosition() === 'floating' && !this.embedded()) {
      this.centerPopup();
    }

    // Iframe URL is set by the effect when config (and optional sandboxId) is available
    this.startConversationPolling();

    // Subscribe to viewer changes to sync readyForPr state
    this.vncViewerService.viewers$.pipe(
      takeUntil(this.destroy$)
    ).subscribe(() => {
      this.syncReadyForPrFromService();
    });

    this.initAgentChatSidebarMediaQuery();
    this.loadFsTopBarPositionFromStorage();
    this.loadFsToolbarOffsetsFromStorage();
  }

  private initAgentChatSidebarMediaQuery(): void {
    if (typeof matchMedia === 'undefined') return;
    const mql = matchMedia(VncViewerComponent.AGENT_CHAT_SIDEBAR_MEDIA);
    this.chatSidebarMql = mql;
    this.applyAgentChatSidebarAllowedFromMedia();
    mql.addEventListener('change', this.onChatSidebarMediaChange);
  }

  private applyAgentChatSidebarAllowedFromMedia(): void {
    const mql = this.chatSidebarMql;
    if (!mql) return;
    const allowed = !mql.matches;
    this.agentChatSidebarAllowed.set(allowed);
    if (!allowed) {
      this.viewMode.set('sandbox');
    }
  }

  /**
   * Start polling for AI conversations from the Bridge API.
   * Uses adaptive interval: 600ms while the LLM is streaming, 3s when idle.
   *
   * Signal updates are deduplicated: conversations/liveResponse are only
   * written when the payload actually changed, preventing unnecessary DOM
   * teardown/rebuild (especially expensive for the markdown pipe).
   */
  /** Fingerprint so we re-sync when the latest turn is updated in place (same id / count). */
  private conversationFingerprint(conversations: ZedConversation[] | undefined): string {
    const list = conversations ?? [];
    if (!list.length) return '';
    return list
      .map((c) => `${c.id}:${(c.user_message ?? '').length}:${(c.assistant_message ?? '').length}`)
      .join('|');
  }

  /** Real user-story GUID only — backend stores bridge snapshots keyed by story + sandbox. */
  private persistableStoryIdForConversations(): string | undefined {
    const id = this.implementationContext()?.storyId?.trim();
    if (!id) return undefined;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return undefined;
    return id;
  }

  /** Loads stored `/all-conversations` snapshots per earlier sandbox run (same story GUID). */
  private loadPriorStorySessionHistoryForOpenSandbox(sandboxId: string): void {
    const storyId = this.persistableStoryIdForConversations();
    if (!storyId) return;

    this.backlogService
      .listStorySandboxAgentSessions(storyId)
      .pipe(
        takeUntil(this.destroy$),
        switchMap((res) => {
          const rows = (res.sessions ?? []).filter((s) => s.sandboxId !== sandboxId);
          if (!rows.length) return of([] as PriorSandboxSessionView[]);
          const sorted = [...rows].sort(
            (a, b) =>
              new Date(a.updatedAt ?? a.createdAt).getTime() -
              new Date(b.updatedAt ?? b.createdAt).getTime()
          );
          return forkJoin(
            sorted.map((r) =>
              this.backlogService.getStorySandboxAgentSessionPayload(storyId, r.sandboxId).pipe(
                catchError(() => of({ conversations: [], count: 0 } as ZedConversationsResponse))
              )
            )
          ).pipe(
            map((payloads) =>
              sorted
                .map((r, idx) => ({
                  sandboxId: r.sandboxId,
                  createdAt: r.createdAt,
                  updatedAt: r.updatedAt,
                  conversations: [...(payloads[idx]?.conversations ?? [])]
                }))
                .filter((s) => s.conversations.length > 0)
            )
          );
        })
      )
      .subscribe({
        next: (sessions) => {
          if (this.sandboxId() !== sandboxId) return;
          if (this.persistableStoryIdForConversations() !== storyId) return;
          this.priorStorySessions.set(sessions);
        },
        error: (err) => console.warn('[VNC] Could not load prior sandbox session history', err)
      });
  }

  /**
   * Render the live streaming content with throttling to avoid DOM thrash.
   * Called from the polling loop each time liveResponse changes.
   */
  private renderLiveStream(content: string | null): void {
    if (!content) {
      if (this._liveRenderTimer) { clearTimeout(this._liveRenderTimer); this._liveRenderTimer = null; }
      this._liveLastRenderedLen = 0;
      this.liveStreamHtml.set('');
      this.liveStreamRendered.set(false);
      return;
    }

    // First chunk → render immediately so the user sees content right away
    if (this._liveLastRenderedLen === 0) {
      this._liveLastRenderedLen = content.length;
      this.liveStreamHtml.set(this.markdownPipe.transform(content));
      this.liveStreamRendered.set(true);
      return;
    }

    // Subsequent chunks → schedule a throttled render (batches multiple poll cycles)
    if (!this._liveRenderTimer) {
      this._liveRenderTimer = setTimeout(() => {
        this._liveRenderTimer = null;
        const live = this.liveResponse();
        const latest = live?.content ?? content;
        this._liveLastRenderedLen = latest.length;
        this.liveStreamHtml.set(this.markdownPipe.transform(latest));
      }, VncViewerComponent.LIVE_RENDER_INTERVAL_MS);
    }
  }

  private startConversationPolling(): void {
    const sid = this.sandboxId();
    if (!sid) return;

    this.loadPriorStorySessionHistoryForOpenSandbox(sid);

    let consecutiveErrors = 0;
    let streaming = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    let prevConvFingerprint: string | null = null;
    let prevLiveLen = 0;
    let pollSandboxId = sid;

    const FAST_MS = 600;
    const SLOW_MS = 3000;

    const poll = () => {
      const currentSid = this.sandboxId();
      if (!currentSid) return;

      if (currentSid !== pollSandboxId) {
        pollSandboxId = currentSid;
        prevConvFingerprint = null;
        prevLiveLen = 0;
        streaming = false;
        this.lastConversationId = '';
        this.conversations.set([]);
        this.priorStorySessions.set([]);
        this.requestInProgress.set(false);
        this.liveResponse.set(null);
        this.renderLiveStream(null);
        this.loadPriorStorySessionHistoryForOpenSandbox(currentSid);
      }

      this.sandboxBridgeService.getAllConversations(
        currentSid,
        this.persistableStoryIdForConversations()
      ).pipe(
        takeUntil(this.destroy$)
      ).subscribe({
        next: (response) => {
          if (this.sandboxId() !== currentSid) {
            schedulePoll(this.sandboxId() ? FAST_MS : SLOW_MS);
            return;
          }

          consecutiveErrors = 0;

          const apiConvs = response.conversations ?? [];
          let convs = apiConvs;
          if (
            apiConvs.length === 0 &&
            untracked(() => this.conversations().length) > 0
          ) {
            convs = untracked(() => this.conversations());
          }
          const fp = this.conversationFingerprint(convs);
          if (prevConvFingerprint === null || fp !== prevConvFingerprint) {
            prevConvFingerprint = fp;
            this.conversations.set(convs);
            const newLatestId = convs.length > 0 ? convs[convs.length - 1].id : '';
            if (newLatestId && newLatestId !== this.lastConversationId) {
              this.lastConversationId = newLatestId;
            }
          }

          const wasStreaming = streaming;
          streaming = response.request_in_progress === true;

          if (!wasStreaming && streaming) {
            if (this._liveRenderTimer) {
              clearTimeout(this._liveRenderTimer);
              this._liveRenderTimer = null;
            }
            this._liveLastRenderedLen = 0;
            prevLiveLen = 0;
          }

          if (streaming !== this.requestInProgress()) {
            this.requestInProgress.set(streaming);
          }

          const liveFromApi = response.live_response?.content ?? '';

          if (streaming) {
            const liveContent = liveFromApi;
            if (liveContent.length !== prevLiveLen) {
              prevLiveLen = liveContent.length;
              this.liveResponse.set(response.live_response ?? null);
              this.renderLiveStream(liveContent || null);
            }
          } else {
            if (wasStreaming) {
              if (this._liveRenderTimer) {
                clearTimeout(this._liveRenderTimer);
                this._liveRenderTimer = null;
              }
              prevLiveLen = 0;
              this.liveResponse.set(null);
              this.renderLiveStream(null);
            } else if (prevLiveLen !== 0) {
              prevLiveLen = 0;
              this.liveResponse.set(null);
              this.renderLiveStream(null);
            }
          }

          this.updatePushPrEligibility({
            ...response,
            conversations: convs,
            count: convs.length
          });

          schedulePoll(streaming ? FAST_MS : SLOW_MS);
        },
        error: (err) => {
          console.warn('[VNC] all-conversations poll failed:', err?.status ?? err);
          consecutiveErrors++;
          if (consecutiveErrors >= 5) {
            if (pollTimer) {
              clearTimeout(pollTimer);
              pollTimer = null;
            }
            return;
          }
          schedulePoll(SLOW_MS);
        }
      });
    };

    const schedulePoll = (ms: number) => {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, ms);
    };

    this.destroy$.subscribe(() => { if (pollTimer) clearTimeout(pollTimer); });
    poll();
  }

  /**
   * Gate "Push & Create PR" on the same heuristic as implementation-complete: avoid enabling
   * right after the first assistant chunk while tool/LLM rounds are still in flight.
   */
  private updatePushPrEligibility(response: ZedConversationsResponse): void {
    const prevEligible = this.canPushPrAfterQuiet();
    const inProgress = response.request_in_progress === true;
    const list = response.conversations;

    let nextEligible = false;

    if (list.length === 0) {
      this.pushPrQuietAccum = { stableLatestId: null, consecutiveStableIdle: 0 };
    } else {
      const latest = list[list.length - 1];
      const hasAssistant = !!latest.assistant_message?.trim();

      if (!hasAssistant) {
        this.pushPrQuietAccum.consecutiveStableIdle = 0;
      } else if (inProgress) {
        this.pushPrQuietAccum.consecutiveStableIdle = 0;
      } else if (this.pushPrQuietAccum.stableLatestId !== latest.id) {
        this.pushPrQuietAccum = { stableLatestId: latest.id, consecutiveStableIdle: 0 };
      } else {
        const next = this.pushPrQuietAccum.consecutiveStableIdle + 1;
        this.pushPrQuietAccum = { stableLatestId: latest.id, consecutiveStableIdle: next };
        nextEligible = next >= SANDBOX_AGENT_QUIET_POLL_COUNT;
      }
    }

    this.canPushPrAfterQuiet.set(nextEligible);
    this.syncReadyForPrWithPushEligibility(prevEligible, nextEligible);
  }

  /**
   * Minimized UI/sound use `readyForPr`; the expanded button uses `canPushPrAfterQuiet`.
   * For user-story sandboxes, drive `readyForPr` from push eligibility so the tray matches the button.
   */
  private syncReadyForPrWithPushEligibility(prevEligible: boolean, nextEligible: boolean): void {
    if (prevEligible === nextEligible) return;
    if (!this.implementationContext()) return;
    if (this.isBacklogSandbox() || this.isAnalysisSandbox()) return;

    if (nextEligible && !prevEligible) {
      this.setReadyForPr(true);
    } else if (!nextEligible && prevEligible) {
      this.setReadyForPr(false);
    }
  }

  setViewMode(mode: 'sandbox' | 'split' | 'chat'): void {
    if (!this.agentChatSidebarAllowed() && mode !== 'sandbox') return;
    this.viewMode.set(mode);
  }

  cleanUserMessage(msg: string): string {
    if (!msg) return msg;
    return msg
      .replace(/(?:You\s*\n)?You\s+MUST\s+respond\s+with\s+a\s+series\s+of\s+edits[\s\S]*?must\s+exactly\s+match\s+existing[^\n]*/gi, '')
      .replace(/You\s+MUST\s+respond\s+with\s+a\s+series\s+of\s+edits[\s\S]*?```/g, '')
      .replace(/#+\s*File Editing Instructions[\s\S]*?(?=\n\n[A-Z]|\n\n#[^#]|$)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  onChatResizeStart(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.chatResizing = true;
    this.chatResizeStartX = event.clientX;
    this.chatResizeStartWidth = this.chatPanelWidth();

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:col-resize;';
    document.body.appendChild(overlay);

    const panel = (event.target as HTMLElement).closest('.conversations-panel') as HTMLElement | null;
    panel?.classList.add('resizing');

    let rafId = 0;
    let pendingWidth = this.chatResizeStartWidth;

    const onMouseMove = (e: MouseEvent) => {
      if (!this.chatResizing) return;
      e.preventDefault();
      pendingWidth = Math.min(Math.max(this.chatResizeStartWidth + (e.clientX - this.chatResizeStartX), 250), 800);
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          this.chatPanelWidth.set(pendingWidth);
        });
      }
    };

    const onMouseUp = () => {
      this.chatResizing = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      this.chatPanelWidth.set(pendingWidth);
      panel?.classList.remove('resizing');
      overlay.remove();
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  /**
   * Handle keydown events in the message textarea
   */
  onMessageKeyDown(event: KeyboardEvent): void {
    // If Enter without Shift, send message
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  /**
   * Push changes and create PR (when implementation context is present)
   */
  pushAndCreatePr(): void {
    const ctx = this.implementationContext();
    const sid = this.sandboxId();
    if (!ctx || !sid || !this.canPushPrAfterQuiet()) return;

    if (ctx.repositoryProvider === 'Unpublished') {
      this.commitUnpublishedToServer();
      return;
    }

    this.pushCreatingPr.set(true);
    this.pushPrError.set(null);
    this.pushPrSuccess.set(null);

    const shortStoryId = ctx.storyId.slice(0, 8);
    const adoWorkItemId = ctx.azureDevOpsWorkItemId;
    const branchName = `feature/US-${adoWorkItemId ?? shortStoryId}-${ctx.storyTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40)}`;
    const commitMessage = `Implement: ${ctx.storyTitle}`;
    const prTitle = adoWorkItemId != null ? `#${adoWorkItemId}: ${ctx.storyTitle}` : `${shortStoryId}: ${ctx.storyTitle}`;
    const prBody = [
      '## Implements User Story',
      '',
      adoWorkItemId != null ? `**Work Item:** #${adoWorkItemId}` : `**Story ID:** \`${ctx.storyId}\``,
      `**Title:** ${ctx.storyTitle}`,
      '',
      'This PR implements the user story as described above.',
      '',
      '---',
      '*Created by DevPilot*'
    ].join('\n');

    // Fetch authenticated clone URL to get credentials for push
    this.repositoryService.getAuthenticatedCloneUrl(ctx.repositoryId).subscribe({
      next: (result) => {
        // Extract credentials from URL (format: https://TOKEN@host/...)
        const gitCredentials = this.extractCredentialsFromUrl(result.cloneUrl);
        this.executePush(sid, ctx, branchName, commitMessage, prTitle, prBody, gitCredentials);
      },
      error: () => {
        this.executePush(sid, ctx, branchName, commitMessage, prTitle, prBody, undefined);
      }
    });
  }

  /**
   * Extract credentials from an authenticated clone URL
   * URL format: https://TOKEN@github.com/... or https://TOKEN@dev.azure.com/...
   */
  private extractCredentialsFromUrl(url: string): string | undefined {
    const match = url.match(/https:\/\/([^@]+)@/);
    return match ? match[1] : undefined;
  }

  /**
   * Zips the sandbox workspace and POSTs to the API to update the on-disk unpublished project.
   */
  private commitUnpublishedToServer(): void {
    const ctx = this.implementationContext();
    const sid = this.sandboxId();
    if (!ctx || !sid || !this.canPushPrAfterQuiet()) {
      return;
    }

    this.pushCreatingPr.set(true);
    this.pushPrError.set(null);
    this.pushPrSuccess.set(null);

    this.sandboxBridgeService.getProjectArchiveZip(sid).subscribe({
      next: (blob) => {
        this.repositoryService.importUnpublishedFromZip(ctx.repositoryId, blob).subscribe({
          next: () => {
            this.pushCreatingPr.set(false);
            this.pushPrSuccess.set({ title: 'Local project updated' });
          },
          error: (err: { error?: { message?: string }; message?: string }) => {
            this.pushCreatingPr.set(false);
            this.pushPrError.set(err.error?.message || err.message || 'Failed to save project');
          }
        });
      },
      error: (err: { message?: string }) => {
        this.pushCreatingPr.set(false);
        this.pushPrError.set(err?.message || 'Failed to read project from sandbox');
      }
    });
  }

  private executePush(
    sandboxId: string,
    ctx: {
      repositoryId: string;
      repositoryFullName: string;
      defaultBranch: string;
      storyTitle: string;
      storyId: string;
      azureDevOpsWorkItemId?: number;
      repositoryProvider?: string;
    },
    branchName: string,
    commitMessage: string,
    prTitle: string,
    prBody: string,
    gitCredentials: string | undefined
  ): void {
    this.sandboxBridgeService.pushAndCreatePr(sandboxId, {
      branchName,
      commitMessage,
      prTitle,
      prBody,
      gitCredentials
    }).subscribe({
      next: () => {
        this.repositoryService.createPullRequest(ctx.repositoryId, {
          headBranch: branchName,
          baseBranch: ctx.defaultBranch,
          title: prTitle,
          body: prBody,
          workItemIds: ctx.azureDevOpsWorkItemId != null ? [ctx.azureDevOpsWorkItemId] : undefined
        }).subscribe({
          next: (pr: { url: string; title: string }) => {
            this.pushCreatingPr.set(false);
            this.pushPrSuccess.set({ url: pr.url, title: pr.title });
            
            // Update story status to "PendingReview" (PR created, awaiting merge)
            // Status will change to "Done" when PR is merged
            this.backlogService.updateStoryStatus(ctx.storyId, 'PendingReview', pr.url).subscribe({
              next: () => console.log('Story status updated to PendingReview with PR URL:', pr.url),
              error: (err) => console.warn('Failed to update story status:', err)
            });
          },
          error: (err: { error?: { message?: string }; message?: string }) => {
            this.pushCreatingPr.set(false);
            this.pushPrError.set(err.error?.message || err.message || 'Failed to create PR');
          }
        });
      },
      error: (err: { error?: { error?: string; message?: string }; message?: string }) => {
        this.pushCreatingPr.set(false);
        this.pushPrError.set(err.error?.error || err.error?.message || err.message || 'Failed to push changes');
      }
    });
  }

  stopGeneration(): void {
    const sid = this.sandboxId();
    if (!sid || !this.requestInProgress()) return;
    this.sandboxBridgeService.abortStream(sid).subscribe();
  }

  /**
   * Send a message to Zed via the Bridge API
   */
  sendMessage(): void {
    const message = this.newMessage.trim();
    const sid = this.sandboxId();

    if (!message || !sid || this.isSending()) {
      return;
    }

    this.isSending.set(true);

    this.sandboxBridgeService.sendZedPrompt(sid, message).subscribe({
      next: (response) => {
        console.log('Message sent to Zed:', response);
        this.newMessage = '';
        this.isSending.set(false);
      },
      error: (err) => {
        console.error('Failed to send message to Zed:', err);
        this.isSending.set(false);
        // Optionally show error notification
      }
    });
  }

  ngOnDestroy(): void {
    const el = this.popupContainerRef?.nativeElement;
    if (el && this.getFullscreenElement() === el) {
      void this.exitDocumentFullscreen();
    }
    document.removeEventListener('fullscreenchange', this.onFullscreenChangeBound);
    document.removeEventListener('webkitfullscreenchange', this.onFullscreenChangeBound as EventListener);
    this.disconnect();
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }
    // Stop polling
    this.destroy$.next();
    this.destroy$.complete();

    if (this._liveRenderTimer) { clearTimeout(this._liveRenderTimer); this._liveRenderTimer = null; }

    if (this.chatSidebarMql) {
      this.chatSidebarMql.removeEventListener('change', this.onChatSidebarMediaChange);
      this.chatSidebarMql = undefined;
    }
  }

  private onFullscreenChange(): void {
    const el = this.popupContainerRef?.nativeElement;
    const fs = !!el && this.getFullscreenElement() === el;
    this.isFullscreen.set(fs);
    if (!fs) {
      this.fsTopBarHidden.set(false);
    }
  }

  toggleFsTopBarHidden(): void {
    this.fsTopBarHidden.update((v) => !v);
  }

  showFsTopBar(): void {
    this.fsTopBarHidden.set(false);
  }

  setFsTopBarPosition(pos: FsTopBarPosition): void {
    this.fsTopBarPosition.set(pos);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(VncViewerComponent.FS_TOP_BAR_POS_STORAGE_KEY, pos);
      }
    } catch {
      /* private mode or quota */
    }
  }

  /** Nearest screen edge in `.popup-content` to snap the bar (center-based). */
  private nearestFsToolbarEdge(cx: number, cy: number, w: number, h: number): FsTopBarPosition {
    const dTop = cy;
    const dRight = w - cx;
    const dBottom = h - cy;
    const dLeft = cx;
    let edge: FsTopBarPosition = 'top';
    let d = dTop;
    if (dRight < d) {
      edge = 'right';
      d = dRight;
    }
    if (dBottom < d) {
      edge = 'bottom';
      d = dBottom;
    }
    if (dLeft < d) {
      edge = 'left';
    }
    return edge;
  }

  onFsToolbarDragStart(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const content = this.popupContentRef?.nativeElement;
    const bar = this.fsFullscreenBarRef?.nativeElement;
    if (!content || !bar) return;
    ev.preventDefault();
    this.fsToolbarDragHasMoved = false;
    const cr = content.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    this.fsToolbarDragOffsetX = ev.clientX - br.left;
    this.fsToolbarDragOffsetY = ev.clientY - br.top;
    this.fsToolbarDragLeft.set(Math.max(0, br.left - cr.left));
    this.fsToolbarDragTop.set(Math.max(0, br.top - cr.top));
    this.fsToolbarDragActive.set(true);
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  onFsToolbarDragMove(ev: PointerEvent): void {
    if (!this.fsToolbarDragActive()) return;
    this.fsToolbarDragHasMoved = true;
    const content = this.popupContentRef?.nativeElement;
    const bar = this.fsFullscreenBarRef?.nativeElement;
    if (!content || !bar) return;
    const cr = content.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    const maxL = Math.max(0, cr.width - br.width);
    const maxT = Math.max(0, cr.height - br.height);
    let nl = ev.clientX - cr.left - this.fsToolbarDragOffsetX;
    let nt = ev.clientY - cr.top - this.fsToolbarDragOffsetY;
    nl = Math.max(0, Math.min(maxL, nl));
    nt = Math.max(0, Math.min(maxT, nt));
    this.fsToolbarDragLeft.set(nl);
    this.fsToolbarDragTop.set(nt);
  }

  onFsToolbarDragEnd(ev: PointerEvent): void {
    if (!this.fsToolbarDragActive()) {
      return;
    }
    const content = this.popupContentRef?.nativeElement;
    const bar = this.fsFullscreenBarRef?.nativeElement;
    if (content && bar && this.fsToolbarDragHasMoved) {
      const cr = content.getBoundingClientRect();
      const br = bar.getBoundingClientRect();
      const w = cr.width;
      const h = cr.height;
      const barW = br.width;
      const barH = br.height;
      const cx = br.left - cr.left + barW / 2;
      const cy = br.top - cr.top + barH / 2;
      const hMax = Math.max(0, w / 2 - barW / 2);
      const vMax = Math.max(0, h / 2 - barH / 2);
      const rawH = cx - w / 2;
      const rawV = cy - h / 2;
      const edge = this.nearestFsToolbarEdge(cx, cy, w, h);
      if (edge === 'top' || edge === 'bottom') {
        this.fsToolbarHOffset.set(hMax > 0 ? Math.max(-hMax, Math.min(hMax, rawH)) : 0);
      } else {
        this.fsToolbarVOffset.set(vMax > 0 ? Math.max(-vMax, Math.min(vMax, rawV)) : 0);
      }
      this.setFsTopBarPosition(edge);
      this.persistFsToolbarOffsets();
    }
    this.fsToolbarDragActive.set(false);
    const el = ev.currentTarget as HTMLElement | null;
    try {
      if (el?.hasPointerCapture?.(ev.pointerId)) {
        el.releasePointerCapture(ev.pointerId);
      }
    } catch {
      /* release may throw if not captured */
    }
  }

  private loadFsTopBarPositionFromStorage(): void {
    let raw: string | null = null;
    try {
      if (typeof localStorage !== 'undefined') {
        raw = localStorage.getItem(VncViewerComponent.FS_TOP_BAR_POS_STORAGE_KEY);
      }
    } catch {
      return;
    }
    if (raw === 'top' || raw === 'right' || raw === 'bottom' || raw === 'left') {
      this.fsTopBarPosition.set(raw);
    }
  }

  private loadFsToolbarOffsetsFromStorage(): void {
    try {
      if (typeof localStorage === 'undefined') {
        return;
      }
      const raw = localStorage.getItem(VncViewerComponent.FS_TOOLBAR_OFFSETS_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const o = JSON.parse(raw) as { h?: unknown; v?: unknown };
      if (typeof o.h === 'number' && Number.isFinite(o.h)) {
        this.fsToolbarHOffset.set(o.h);
      }
      if (typeof o.v === 'number' && Number.isFinite(o.v)) {
        this.fsToolbarVOffset.set(o.v);
      }
    } catch {
      /* bad JSON or private mode */
    }
  }

  private persistFsToolbarOffsets(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          VncViewerComponent.FS_TOOLBAR_OFFSETS_STORAGE_KEY,
          JSON.stringify({ h: this.fsToolbarHOffset(), v: this.fsToolbarVOffset() })
        );
      }
    } catch {
      /* quota / private */
    }
  }

  private getFullscreenElement(): Element | null {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  }

  private requestElementFullscreen(el: HTMLElement): Promise<void> {
    const anyEl = el as HTMLElement & {
      requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
      webkitRequestFullscreen?: () => void;
    };
    if (typeof anyEl.requestFullscreen === 'function') {
      return anyEl.requestFullscreen();
    }
    if (typeof anyEl.webkitRequestFullscreen === 'function') {
      anyEl.webkitRequestFullscreen();
      return Promise.resolve();
    }
    return Promise.reject(new Error('Fullscreen API not available'));
  }

  private exitDocumentFullscreen(): Promise<void> {
    const doc = document as Document & { webkitExitFullscreen?: () => void };
    if (typeof document.exitFullscreen === 'function') {
      return document.exitFullscreen();
    }
    if (typeof doc.webkitExitFullscreen === 'function') {
      doc.webkitExitFullscreen();
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  private centerPopup(): void {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    this.popupX.set(Math.max(50, (viewportWidth - this.popupWidth()) / 2));
    this.popupY.set(Math.max(50, (viewportHeight - this.popupHeight()) / 2));
  }

  setupIframeUrl(): void {
    const config = this.internalConfig();
    if (!config.url || config.url.trim() === '') {
      this.error.set('VNC server URL is required');
      return;
    }

    // Clear any existing timeout
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }

    const finalUrl = config.url;
    console.log('VNC iframe URL:', finalUrl);

    // Set connection state and URL
    this.connectionState.set(VncConnectionState.Connecting);
    this.error.set(null);
    this.vncIframeUrlRaw.set(finalUrl);

    this.connectionRetryCount = 0;

    // Auto-refresh after 2s and 6s to give sandbox time to become ready
    setTimeout(() => {
      if (this.connectionState() === VncConnectionState.Connecting) {
        console.log('Auto-refreshing iframe (2s)...');
        this.refreshIframe();
      }
    }, 2000);
    setTimeout(() => {
      if (this.connectionState() === VncConnectionState.Connecting) {
        console.log('Auto-refreshing iframe (6s)...');
        this.refreshIframe();
      }
    }, 6000);

    // Mark as connected after timeout. When minimized, iframe isn't rendered so onIframeLoad never fires –
    // use a shorter delay since we can't rely on iframe load.
    const delayMs = this.dockPosition() === 'minimized' ? 2000 : VncViewerComponent.CONNECTION_ESTABLISHED_MS;
    this.connectionTimeout = setTimeout(() => {
      if (this.connectionState() === VncConnectionState.Connecting) {
        console.log('VNC connection established');
        this.connectionState.set(VncConnectionState.Connected);
        this.everConnected.set(true);
        this.startHealthCheck();
      }
    }, delayMs);
  }

  // Connection methods
  connect(): void {
    const config = this.internalConfig();
    if (!config.url || config.url.trim() === '') {
      this.error.set('VNC server URL is required');
      return;
    }
    this.error.set(null);
    this.stopAutoReconnect();
    this.connectionState.set(VncConnectionState.Connecting);
    const sid = this.sandboxId();
    if (sid) {
      this.vncIframeUrlRaw.set('');
      if (this.bridgeWaitIntervalId) {
        clearInterval(this.bridgeWaitIntervalId);
        this.bridgeWaitIntervalId = null;
      }
      this.waitForBridgeThenSetupIframe(sid);
    } else {
      this.setupIframeUrl();
    }
  }

  disconnect(): void {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    if (this.connectionRetryTimeout) {
      clearTimeout(this.connectionRetryTimeout);
      this.connectionRetryTimeout = null;
    }
    if (this.bridgeWaitIntervalId) {
      clearInterval(this.bridgeWaitIntervalId);
      this.bridgeWaitIntervalId = null;
    }
    this.stopAutoReconnect();
    this.stopHealthCheck();
    this.stopStatsRefresh();
    this.connectionRetryCount = 0;
    this.vncIframeUrlRaw.set('');
    this.connectionState.set(VncConnectionState.Disconnected);
  }

  // ── Auto-reconnect ──────────────────────────────────────────────────────────

  private startHealthCheck(): void {
    if (this.healthCheckInterval) return;
    const sid = this.sandboxId();
    if (!sid) return;
    this.consecutiveHealthFailures = 0;
    this.healthCheckInterval = setInterval(() => {
      this.sandboxBridgeService.checkHealth(sid).subscribe(resp => {
        if (resp) {
          if (this.isReconnecting()) {
            this.onReconnectSuccess();
          }
          this.consecutiveHealthFailures = 0;
        } else {
          this.consecutiveHealthFailures++;
          if (this.consecutiveHealthFailures >= VncViewerComponent.HEALTH_FAILURE_THRESHOLD && !this.isReconnecting()) {
            this.startAutoReconnect();
          }
        }
      });
    }, VncViewerComponent.HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private startAutoReconnect(): void {
    if (this.reconnectAttempt() >= VncViewerComponent.MAX_RECONNECT_ATTEMPTS) {
      this.isReconnecting.set(false);
      if (!this.everConnected()) {
        this.connectionState.set(VncConnectionState.Error);
        this.error.set('Lost connection to sandbox. Click Retry to reconnect.');
      }
      return;
    }
    this.isReconnecting.set(true);
    this.error.set(null);
    this.reconnectAttempt.update(n => n + 1);
    console.log(`Auto-reconnecting (attempt ${this.reconnectAttempt()}/${VncViewerComponent.MAX_RECONNECT_ATTEMPTS})...`);

    this.reconnectTimeout = setTimeout(() => {
      this.refreshIframe();
      const sid = this.sandboxId();
      if (sid) {
        this.sandboxBridgeService.checkHealth(sid).subscribe(resp => {
          if (resp) {
            this.onReconnectSuccess();
          } else if (this.reconnectAttempt() < VncViewerComponent.MAX_RECONNECT_ATTEMPTS) {
            this.startAutoReconnect();
          } else {
            this.isReconnecting.set(false);
            if (!this.everConnected()) {
              this.connectionState.set(VncConnectionState.Error);
              this.error.set('Lost connection to sandbox. Click Retry to reconnect.');
            }
          }
        });
      }
    }, VncViewerComponent.RECONNECT_DELAY_MS_AUTO);
  }

  private onReconnectSuccess(): void {
    console.log('Reconnected successfully');
    this.isReconnecting.set(false);
    this.reconnectAttempt.set(0);
    this.consecutiveHealthFailures = 0;
    this.connectionState.set(VncConnectionState.Connected);
    this.error.set(null);
  }

  private stopAutoReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.isReconnecting.set(false);
    this.reconnectAttempt.set(0);
  }

  // ── Stats overlay ───────────────────────────────────────────────────────────

  toggleStats(): void {
    const show = !this.showStatsOverlay();
    this.showStatsOverlay.set(show);
    if (show) {
      this.refreshStats();
      this.startStatsRefresh();
    } else {
      this.stopStatsRefresh();
    }
  }

  private refreshStats(): void {
    const sid = this.sandboxId();
    if (!sid) return;
    const t0 = performance.now();
    this.sandboxBridgeService.getSystemInfo(sid).subscribe(stats => {
      this.bridgeLatencyMs.set(Math.round(performance.now() - t0));
      if (stats) this.sandboxStats.set(stats);
    });
  }

  private startStatsRefresh(): void {
    this.stopStatsRefresh();
    this.statsRefreshInterval = setInterval(() => this.refreshStats(), 5000);
  }

  private stopStatsRefresh(): void {
    if (this.statsRefreshInterval) {
      clearInterval(this.statsRefreshInterval);
      this.statsRefreshInterval = null;
    }
  }

  formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // UI State methods
  isConnected(): boolean {
    return this.connectionState() === VncConnectionState.Connected;
  }

  isConnecting(): boolean {
    return this.connectionState() === VncConnectionState.Connecting;
  }

  hasError(): boolean {
    return this.connectionState() === VncConnectionState.Error;
  }

  /**
   * Reads the host clipboard in the browser and sends it into the sandbox via the bridge
   * (xclip + Ctrl+V). Use when normal copy/paste through noVNC does not reach Zed.
   */
  pasteFromHostClipboard(): void {
    const sid = this.sandboxId();
    if (!sid) {
      this.pasteFromHostMessage.set('Sandbox bridge is not available.');
      setTimeout(() => this.pasteFromHostMessage.set(null), 4000);
      return;
    }
    if (!navigator.clipboard?.readText) {
      this.pasteFromHostMessage.set('Clipboard API not available. Use a secure context (HTTPS) or a supported browser.');
      setTimeout(() => this.pasteFromHostMessage.set(null), 5000);
      return;
    }
    this.pasteFromHostBusy.set(true);
    this.pasteFromHostMessage.set(null);
    navigator.clipboard.readText().then((text) => {
      if (!text) {
        this.pasteFromHostBusy.set(false);
        this.pasteFromHostMessage.set('Clipboard is empty.');
        setTimeout(() => this.pasteFromHostMessage.set(null), 3000);
        return;
      }
      this.sandboxBridgeService.pasteHostClipboardIntoSandbox(sid, text).subscribe({
        next: () => {
          this.pasteFromHostBusy.set(false);
          this.pasteFromHostMessage.set('Pasted into sandbox.');
          setTimeout(() => this.pasteFromHostMessage.set(null), 2500);
        },
        error: (err) => {
          this.pasteFromHostBusy.set(false);
          const msg = err?.error?.error || err?.message || 'Paste failed';
          this.pasteFromHostMessage.set(String(msg));
          setTimeout(() => this.pasteFromHostMessage.set(null), 5000);
        }
      });
    }).catch(() => {
      this.pasteFromHostBusy.set(false);
      this.pasteFromHostMessage.set('Could not read clipboard. Click the button again after copying, or allow clipboard permission.');
      setTimeout(() => this.pasteFromHostMessage.set(null), 5000);
    });
  }

  // Dock methods
  setDockPosition(position: DockPosition): void {
    this.dockPosition.set(position);
    const id = this.viewerId();
    if (id) {
      this.vncViewerService.setDockPosition(id, position);
    }
  }

  toggleMinimize(): void {
    const id = this.viewerId();
    if (!id) return;
    const cur = this.dockPosition();
    const newPosition = cur === 'minimized' ? 'tiled' : 'minimized';
    const v = this.vncViewerService.getViewer(id);
    if (v?.hideMinimizedTray && newPosition === 'minimized') {
      this.vncViewerService.dismissViewerKeepSandbox(id);
      return;
    }
    this.dockPosition.set(newPosition);
    this.vncViewerService.setDockPosition(id, newPosition);
  }

  /**
   * Mark this sandbox as ready for PR (implementation complete)
   * Shows a visual indicator on the minimized widget
   */
  setReadyForPr(ready: boolean): void {
    const wasReady = this.readyForPr();
    this.readyForPr.set(ready);
    const id = this.viewerId();
    if (id) {
      untracked(() => this.vncViewerService.setReadyForPr(id, ready));
    }
    if (ready && !wasReady && (this.dockPosition() === 'minimized' || this.dockPosition() === 'tiled')) {
      this.playAlertSound();
    }
  }

  /**
   * Play a simple alert sound using Web Audio API
   */
  private playAlertSound(): void {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      // Pleasant success chime
      oscillator.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      oscillator.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1); // E5
      oscillator.frequency.setValueAtTime(783.99, ctx.currentTime + 0.2); // G5
      gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.4);
    } catch (e) {
      console.warn('Could not play alert sound:', e);
    }
  }

  toggleFullscreen(): void {
    const el = this.popupContainerRef?.nativeElement;
    if (!el) {
      this.isFullscreen.update(v => {
        this.fsTopBarHidden.set(false);
        return !v;
      });
      return;
    }
    if (this.getFullscreenElement() === el) {
      void this.exitDocumentFullscreen();
      return;
    }
    void this.requestElementFullscreen(el).catch(() => {
      // Safari-blocked, or unsupported — fall back to CSS “fullscreen” (works for floating; may clip in dock)
      this.isFullscreen.update(v => {
        this.fsTopBarHidden.set(false);
        return !v;
      });
    });
  }

  openInNewTab(): void {
    const url = this.vncIframeUrlRaw();
    if (url) {
      window.open(url, '_blank');
    }
  }

  refreshIframe(): void {
    const currentUrl = this.vncIframeUrlRaw();
    if (currentUrl && this.vncIframeRef?.nativeElement) {
      console.log('Refreshing iframe...');
      this.vncIframeRef.nativeElement.src = currentUrl;
      if (!this.everConnected()) {
        this.connectionState.set(VncConnectionState.Connecting);
      }
    }
  }

  // Open VNC in a popup window (bypasses iframe restrictions)
  private vncPopupWindow: Window | null = null;

  openInPopupWindow(): void {
    const url = this.vncIframeUrlRaw();
    if (!url) return;

    // Close existing popup if any
    if (this.vncPopupWindow && !this.vncPopupWindow.closed) {
      this.vncPopupWindow.focus();
      return;
    }

    // Open popup window with specific dimensions
    const width = 1200;
    const height = 800;
    const left = (screen.width - width) / 2;
    const top = (screen.height - height) / 2;

    this.vncPopupWindow = window.open(
      url,
      'VNC_Desktop',
      `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=no,status=no`
    );

    if (this.vncPopupWindow) {
      this.connectionState.set(VncConnectionState.Connected);

      // Monitor popup close
      const checkClosed = setInterval(() => {
        if (this.vncPopupWindow?.closed) {
          clearInterval(checkClosed);
          this.connectionState.set(VncConnectionState.Disconnected);
          this.vncPopupWindow = null;
        }
      }, 1000);
    }
  }

  close(): void {
    this.destroy$.next();
    this.disconnect();
    // Close popup window if open
    if (this.vncPopupWindow && !this.vncPopupWindow.closed) {
      this.vncPopupWindow.close();
      this.vncPopupWindow = null;
    }
    this.closeEvent.emit();
  }

  // Dragging handlers
  onDragStart(event: MouseEvent): void {
    if (this.dockPosition() !== 'floating') return;

    this.isDragging = true;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.dragOffsetX = this.popupX();
    this.dragOffsetY = this.popupY();

    event.preventDefault();
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (this.isDragging) {
      const deltaX = event.clientX - this.dragStartX;
      const deltaY = event.clientY - this.dragStartY;

      const newX = Math.max(0, Math.min(window.innerWidth - 100, this.dragOffsetX + deltaX));
      const newY = Math.max(0, Math.min(window.innerHeight - 50, this.dragOffsetY + deltaY));

      this.popupX.set(newX);
      this.popupY.set(newY);
    }

    if (this.isResizing) {
      this.handleResize(event);
    }
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    this.isDragging = false;
    this.isResizing = false;
  }

  // Resize handlers
  onResizeStart(event: MouseEvent, direction: string): void {
    if (this.dockPosition() !== 'floating') return;

    this.isResizing = true;
    this.resizeDirection = direction;
    this.resizeStartWidth = this.popupWidth();
    this.resizeStartHeight = this.popupHeight();
    this.resizeStartX = event.clientX;
    this.resizeStartY = event.clientY;

    event.preventDefault();
    event.stopPropagation();
  }

  private handleResize(event: MouseEvent): void {
    const deltaX = event.clientX - this.resizeStartX;
    const deltaY = event.clientY - this.resizeStartY;

    if (this.resizeDirection.includes('e')) {
      this.popupWidth.set(Math.max(400, this.resizeStartWidth + deltaX));
    }
    if (this.resizeDirection.includes('w')) {
      const newWidth = Math.max(400, this.resizeStartWidth - deltaX);
      if (newWidth !== this.popupWidth()) {
        this.popupX.set(this.popupX() + (this.popupWidth() - newWidth));
        this.popupWidth.set(newWidth);
      }
    }
    if (this.resizeDirection.includes('s')) {
      this.popupHeight.set(Math.max(300, this.resizeStartHeight + deltaY));
    }
    if (this.resizeDirection.includes('n')) {
      const newHeight = Math.max(300, this.resizeStartHeight - deltaY);
      if (newHeight !== this.popupHeight()) {
        this.popupY.set(this.popupY() + (this.popupHeight() - newHeight));
        this.popupHeight.set(newHeight);
      }
    }
  }

  // Iframe events
  onIframeLoad(): void {
    // Ignore load events from about:blank or when we're still waiting for the bridge
    const currentUrl = this.vncIframeUrlRaw();
    if (!currentUrl || currentUrl.trim() === '' || this.bridgeWaitIntervalId) {
      console.log('VNC iframe loaded (about:blank or bridge not ready yet, ignoring)');
      return;
    }

    console.log('VNC iframe loaded');
    this.connectionRetryCount = 0;
    if (this.connectionRetryTimeout) {
      clearTimeout(this.connectionRetryTimeout);
      this.connectionRetryTimeout = null;
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    this.connectionState.set(VncConnectionState.Connected);
    this.everConnected.set(true);
    this.error.set(null);
    this.stopAutoReconnect();
    this.startHealthCheck();
  }

  onIframeError(): void {
    this.connectionRetryCount += 1;
    console.warn('VNC iframe load error, retry', this.connectionRetryCount, 'of', VncViewerComponent.MAX_CONNECTION_RETRIES);

    if (this.connectionRetryCount < VncViewerComponent.MAX_CONNECTION_RETRIES) {
      this.connectionState.set(VncConnectionState.Connecting);
      this.error.set(null);
      this.connectionRetryTimeout = setTimeout(() => {
        this.connectionRetryTimeout = null;
        if (this.connectionState() === VncConnectionState.Connecting && this.vncIframeUrlRaw()) {
          console.log('Retrying VNC connection...');
          this.refreshIframe();
        }
      }, VncViewerComponent.RETRY_DELAY_MS);
    } else {
      console.warn('VNC iframe failed initial retries, starting auto-reconnect...');
      if (this.connectionRetryTimeout) {
        clearTimeout(this.connectionRetryTimeout);
        this.connectionRetryTimeout = null;
      }
      this.startAutoReconnect();
    }
  }

  exitFullscreen(): void {
    const el = this.popupContainerRef?.nativeElement;
    if (el && this.getFullscreenElement() === el) {
      void this.exitDocumentFullscreen();
    }
    this.isFullscreen.set(false);
  }
}
