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
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Subject, interval, takeUntil, switchMap, filter, startWith, EMPTY, catchError } from 'rxjs';
import { VncService } from '../../core/services/vnc.service';
import { VncViewerService, DockPosition } from '../../core/services/vnc-viewer.service';
import {
  SandboxBridgeService,
  ZedConversation,
  ZedConversationsResponse,
  SANDBOX_AGENT_QUIET_POLL_COUNT
} from '../../core/services/sandbox-bridge.service';
import { RepositoryService } from '../../core/services/repository.service';
import { BacklogService } from '../../core/services/backlog.service';
import { VncConfig, VncConnectionState, DEFAULT_VNC_CONFIG } from '../../shared/models/vnc-config.model';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe';

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

  // Inputs
  config = input.required<VncConfig>();
  viewerId = input<string>('');
  initialDockPosition = input<DockPosition>('floating');
  initialConnectionState = input<string | undefined>(undefined); // From service when viewer moves floating↔minimized
  viewerTitle = input<string>('Sandbox');
  embedded = input<boolean>(false); // When true, renders without container/header (for dock panel)
  bridgePort = input<number | undefined>(undefined); // Bridge API port for this sandbox
  implementationContext = input<{ repositoryId: string; repositoryFullName: string; defaultBranch: string; storyTitle: string; storyId: string; azureDevOpsWorkItemId?: number } | undefined>(undefined); // Enables Push & Create PR

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

  // UI State
  dockPosition = signal<DockPosition>('floating');
  isFullscreen = signal<boolean>(false);
  showControls = signal<boolean>(true);

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

  // Wait for bridge (AI conversations) before loading iframe when bridgePort is set
  private bridgeWaitIntervalId: ReturnType<typeof setInterval> | null = null;
  private static readonly BRIDGE_POLL_INTERVAL_MS = 1500;  // Poll bridge health every 1.5s
  private static readonly BRIDGE_MAX_WAIT_MS = 25000;      // Stop waiting after 25s and load iframe anyway

  // Conversations state
  conversations = signal<ZedConversation[]>([]);
  showConversations = signal<boolean>(false); // Collapsed until user opens chat
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

  // Push & Create PR state
  pushCreatingPr = signal<boolean>(false);
  pushPrError = signal<string | null>(null);
  pushPrSuccess = signal<{ url: string; title: string } | null>(null);

  /** Clipboard: paste from host OS into sandbox (bridge /clipboard/paste) */
  pasteFromHostBusy = signal<boolean>(false);
  pasteFromHostMessage = signal<string | null>(null);

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
    private backlogService: BacklogService
  ) {
    // Update config when input changes. When bridgePort is set, wait for bridge health before loading iframe.
    effect(() => {
      const inputConfig = this.config();
      if (inputConfig) {
        const mergedConfig = { ...DEFAULT_VNC_CONFIG, ...inputConfig };
        this.internalConfig.set(mergedConfig);
        if (mergedConfig.url && mergedConfig.url.trim() !== '') {
          const port = this.bridgePort();
          if (port) {
            if (this.bridgeWaitIntervalId) {
              clearInterval(this.bridgeWaitIntervalId);
              this.bridgeWaitIntervalId = null;
            }
            this.waitForBridgeThenSetupIframe(port);
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

    // When the dock mounts a new tile, viewerId can lag behind the first viewers$ emission;
    // re-pull readyForPr from the service whenever id is set.
    effect(() => {
      const id = this.viewerId();
      if (!id) return;
      untracked(() => this.syncReadyForPrFromService());
    }, { allowSignalWrites: true });
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

  /**
   * When opening sandbox with AI conversations (bridgePort set), wait for the bridge to respond
   * to /health before loading the VNC iframe. This avoids "unable to connect" when the bridge
   * starts a few seconds after the sandbox.
   */
  private waitForBridgeThenSetupIframe(bridgePort: number): void {
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
      this.sandboxBridgeService.health(bridgePort).subscribe({
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

    // Iframe URL is set by the effect when config (and optional bridgePort) is available

    // Start conversation polling if bridge port is provided
    this.startConversationPolling();

    // Subscribe to viewer changes to sync readyForPr state
    this.vncViewerService.viewers$.pipe(
      takeUntil(this.destroy$)
    ).subscribe(() => {
      this.syncReadyForPrFromService();
    });
  }

  /**
   * Start polling for AI conversations from the Bridge API
   * Fetches immediately then every 3s (so restored sandboxes show existing LLM chat right away)
   */
  private startConversationPolling(): void {
    const port = this.bridgePort();
    if (!port) return;

    let consecutiveErrors = 0;

    // Fetch immediately then every 3 seconds
    interval(3000).pipe(
      startWith(0),
      takeUntil(this.destroy$),
      filter(() => !!this.bridgePort()),
      switchMap(() =>
        this.sandboxBridgeService.getAllConversations(this.bridgePort()!).pipe(
          catchError(_err => {
            consecutiveErrors++;
            if (consecutiveErrors >= 3) {
              // Bridge unreachable — container likely stopped
              this.connectionState.set(VncConnectionState.Error);
              this.error.set('Sandbox stopped or unreachable. Close this viewer to clean up.');
            }
            return EMPTY;
          })
        )
      )
    ).subscribe({
      next: (response) => {
        consecutiveErrors = 0;
        if (response.conversations.length > 0) {
          this.conversations.set(response.conversations);
          const latestId = response.conversations[response.conversations.length - 1]?.id;
          if (latestId && latestId !== this.lastConversationId) {
            this.lastConversationId = latestId;
            console.log('New conversation in sandbox:', this.viewerId());
          }
        }
        this.updatePushPrEligibility(response);
      }
    });
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

  /**
   * Toggle conversations panel visibility
   */
  toggleConversations(): void {
    this.showConversations.set(!this.showConversations());
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

    // Block iframe from stealing mouse events during drag
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:col-resize;';
    document.body.appendChild(overlay);

    const onMouseMove = (e: MouseEvent) => {
      if (!this.chatResizing) return;
      e.preventDefault();
      const delta = e.clientX - this.chatResizeStartX;
      const newWidth = Math.min(Math.max(this.chatResizeStartWidth + delta, 250), 800);
      this.chatPanelWidth.set(newWidth);
    };

    const onMouseUp = () => {
      this.chatResizing = false;
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
    const port = this.bridgePort();
    if (!ctx || !port || !this.canPushPrAfterQuiet()) return;

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
        this.executePush(port, ctx, branchName, commitMessage, prTitle, prBody, gitCredentials);
      },
      error: () => {
        // Try without credentials
        this.executePush(port, ctx, branchName, commitMessage, prTitle, prBody, undefined);
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

  private executePush(
    port: number,
    ctx: { repositoryId: string; repositoryFullName: string; defaultBranch: string; storyTitle: string; storyId: string; azureDevOpsWorkItemId?: number },
    branchName: string,
    commitMessage: string,
    prTitle: string,
    prBody: string,
    gitCredentials: string | undefined
  ): void {
    this.sandboxBridgeService.pushAndCreatePr(port, {
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

  /**
   * Send a message to Zed via the Bridge API
   */
  sendMessage(): void {
    const message = this.newMessage.trim();
    const port = this.bridgePort();

    if (!message || !port || this.isSending()) {
      return;
    }

    this.isSending.set(true);

    // Send the prompt to Zed via Bridge API
    this.sandboxBridgeService.sendZedPrompt(port, message).subscribe({
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
  }

  private onFullscreenChange(): void {
    const el = this.popupContainerRef?.nativeElement;
    this.isFullscreen.set(!!el && this.getFullscreenElement() === el);
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

    const vncPassword = this.vncViewerService.getViewer(this.viewerId())?.vncPassword;
    const finalUrl = this.vncService.buildIframeUrl(config, vncPassword);
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
    this.connectionState.set(VncConnectionState.Connecting);
    const port = this.bridgePort();
    if (port) {
      this.vncIframeUrlRaw.set(''); // show loading overlay while waiting for bridge
      if (this.bridgeWaitIntervalId) {
        clearInterval(this.bridgeWaitIntervalId);
        this.bridgeWaitIntervalId = null;
      }
      this.waitForBridgeThenSetupIframe(port);
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
    this.connectionRetryCount = 0;
    this.vncIframeUrlRaw.set('');
    this.connectionState.set(VncConnectionState.Disconnected);
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
    const port = this.bridgePort();
    if (!port) {
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
      this.sandboxBridgeService.pasteHostClipboardIntoSandbox(port, text).subscribe({
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
    const newPosition = this.dockPosition() === 'minimized' ? 'tiled' : 'minimized';
    this.dockPosition.set(newPosition);
    const id = this.viewerId();
    if (id) {
      this.vncViewerService.setDockPosition(id, newPosition);
    }
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
      this.isFullscreen.update(v => !v);
      return;
    }
    if (this.getFullscreenElement() === el) {
      void this.exitDocumentFullscreen();
      return;
    }
    void this.requestElementFullscreen(el).catch(() => {
      // Safari-blocked, or unsupported — fall back to CSS “fullscreen” (works for floating; may clip in dock)
      this.isFullscreen.update(v => !v);
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
      // Force reload by setting src again
      this.vncIframeRef.nativeElement.src = currentUrl;
      this.connectionState.set(VncConnectionState.Connecting);
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
    this.error.set(null);
  }

  onIframeError(): void {
    this.connectionRetryCount += 1;
    console.warn('VNC iframe load error, retry', this.connectionRetryCount, 'of', VncViewerComponent.MAX_CONNECTION_RETRIES);

    if (this.connectionRetryCount < VncViewerComponent.MAX_CONNECTION_RETRIES) {
      // Sandbox may still be starting; retry after a delay
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
      console.error('VNC iframe failed after retries');
      if (this.connectionRetryTimeout) {
        clearTimeout(this.connectionRetryTimeout);
        this.connectionRetryTimeout = null;
      }
      this.connectionState.set(VncConnectionState.Error);
      this.error.set('Failed to load VNC viewer after retries. Check your VPS connection or try "Connect" again.');
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
