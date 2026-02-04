import { Component, OnInit, OnDestroy, ViewChild, ElementRef, signal, effect, input, output, computed, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Subject, interval, takeUntil, switchMap, filter, startWith } from 'rxjs';
import { VncService } from '../../core/services/vnc.service';
import { VncViewerService, DockPosition } from '../../core/services/vnc-viewer.service';
import { SandboxBridgeService, ZedConversation } from '../../core/services/sandbox-bridge.service';
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
export class VncViewerComponent implements OnInit, OnDestroy {
  @ViewChild('vncIframe', { static: false }) vncIframeRef!: ElementRef<HTMLIFrameElement>;
  @ViewChild('popupContainer', { static: false }) popupContainerRef!: ElementRef<HTMLDivElement>;

  // Inputs
  config = input.required<VncConfig>();
  viewerId = input<string>('');
  initialDockPosition = input<DockPosition>('floating');
  viewerTitle = input<string>('Sandbox');
  viewerIndex = input<number>(0); // Index for positioning multiple minimized widgets
  embedded = input<boolean>(false); // When true, renders without container/header (for dock panel)
  bridgePort = input<number | undefined>(undefined); // Bridge API port for this sandbox
  implementationContext = input<{ repositoryId: string; repositoryFullName: string; defaultBranch: string; storyTitle: string; storyId: string } | undefined>(undefined); // Enables Push & Create PR

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

  // Connection timeout
  private connectionTimeout: any = null;

  // Conversations state
  conversations = signal<ZedConversation[]>([]);
  showConversations = signal<boolean>(true); // Show by default
  isSending = signal<boolean>(false);
  newMessage = '';
  private destroy$ = new Subject<void>();
  private lastConversationId = '';

  // Push & Create PR state
  pushCreatingPr = signal<boolean>(false);
  pushPrError = signal<string | null>(null);
  pushPrSuccess = signal<{ url: string; title: string } | null>(null);

  // Ready for PR state - shows alert on minimized widget
  readyForPr = signal<boolean>(false);

  // Check if this is an analysis sandbox (not a user story implementation)
  isAnalysisSandbox = computed(() => {
    const ctx = this.implementationContext();
    return ctx?.storyId?.startsWith('analysis-') ?? false;
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

  // Computed style for minimized widget position (stacks horizontally from right)
  minimizedStyle = computed(() => {
    const index = this.viewerIndex();
    const widgetWidth = 320; // Approximate width of minimized widget (increased for safety)
    const gap = 20; // Gap between widgets
    const rightOffset = 20 + (index * (widgetWidth + gap));
    return {
      right: `${rightOffset}px`
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
    // Update config when input changes
    effect(() => {
      const inputConfig = this.config();
      if (inputConfig) {
        const mergedConfig = { ...DEFAULT_VNC_CONFIG, ...inputConfig };
        this.internalConfig.set(mergedConfig);
        if (mergedConfig.url) {
          this.setupIframeUrl();
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
  }

  /**
   * Sync readyForPr state from service
   */
  private syncReadyForPrFromService(): void {
    const id = this.viewerId();
    if (id) {
      const viewer = this.vncViewerService.getViewer(id);
      if (viewer?.readyForPr !== undefined && viewer.readyForPr !== this.readyForPr()) {
        this.readyForPr.set(viewer.readyForPr);
        if (viewer.readyForPr && this.dockPosition() === 'minimized') {
          this.playAlertSound();
        }
      }
    }
  }

  ngOnInit(): void {
    // Set initial dock position from input
    const initialPos = this.initialDockPosition();
    if (initialPos) {
      this.dockPosition.set(initialPos);
    }

    // Center the popup initially (only if floating and not embedded)
    if (this.dockPosition() === 'floating' && !this.embedded()) {
      this.centerPopup();
    }

    // Listen for fullscreen changes
    document.addEventListener('fullscreenchange', this.handleFullscreenChange);

    // Setup iframe URL
    setTimeout(() => {
      const config = this.internalConfig();
      if (config.url && config.url.trim() !== '') {
        this.setupIframeUrl();
      }
    }, 100);

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

    // Fetch immediately then every 3 seconds
    interval(3000).pipe(
      startWith(0),
      takeUntil(this.destroy$),
      filter(() => !!this.bridgePort()),
      switchMap(() => this.sandboxBridgeService.getAllConversations(this.bridgePort()!))
    ).subscribe({
      next: (response) => {
        if (response.conversations.length > 0) {
          this.conversations.set(response.conversations);
          const latestId = response.conversations[response.conversations.length - 1]?.id;
          if (latestId && latestId !== this.lastConversationId) {
            this.lastConversationId = latestId;
            console.log('New conversation in sandbox:', this.viewerId());
          }
        }
      },
      error: (err) => console.warn('Failed to poll conversations:', err)
    });
  }

  /**
   * Toggle conversations panel visibility
   */
  toggleConversations(): void {
    this.showConversations.set(!this.showConversations());
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
    if (!ctx || !port) return;

    this.pushCreatingPr.set(true);
    this.pushPrError.set(null);
    this.pushPrSuccess.set(null);

    const branchName = `feature/US-${ctx.storyId.slice(0, 8)}-${ctx.storyTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40)}`;
    const commitMessage = `Implement: ${ctx.storyTitle}`;
    const prTitle = `Implement: ${ctx.storyTitle}`;
    const prBody = `Implements user story: **${ctx.storyTitle}**\n\nThis PR was created by DevPilot after completing the implementation.`;

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
    ctx: { repositoryId: string; repositoryFullName: string; defaultBranch: string; storyTitle: string; storyId: string },
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
          body: prBody
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
    this.disconnect();
    document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }
    // Stop polling
    this.destroy$.next();
    this.destroy$.complete();
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

    const finalUrl = this.vncService.buildIframeUrl(config);
    console.log('VNC iframe URL:', finalUrl);

    // Set connection state and URL
    this.connectionState.set(VncConnectionState.Connecting);
    this.error.set(null);
    this.vncIframeUrlRaw.set(finalUrl);

    // Auto-refresh after 2 seconds to ensure connection
    setTimeout(() => {
      if (this.connectionState() === VncConnectionState.Connecting) {
        console.log('Auto-refreshing iframe for better connection...');
        this.refreshIframe();
      }
    }, 2000);

    // Mark as connected after total 4 seconds
    this.connectionTimeout = setTimeout(() => {
      if (this.connectionState() === VncConnectionState.Connecting) {
        console.log('VNC connection established');
        this.connectionState.set(VncConnectionState.Connected);
      }
    }, 4000);
  }

  // Connection methods
  connect(): void {
    const config = this.internalConfig();
    if (!config.url || config.url.trim() === '') {
      this.error.set('VNC server URL is required');
      return;
    }
    this.setupIframeUrl();
  }

  disconnect(): void {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
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

  // Dock methods
  setDockPosition(position: DockPosition): void {
    this.dockPosition.set(position);
    const id = this.viewerId();
    if (id) {
      this.vncViewerService.setDockPosition(id, position);
    }
  }

  toggleMinimize(): void {
    const newPosition = this.dockPosition() === 'minimized' ? 'floating' : 'minimized';
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
    this.readyForPr.set(ready);
    // If ready and minimized, play a sound to alert user
    if (ready && this.dockPosition() === 'minimized') {
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
    if (this.vncIframeRef?.nativeElement) {
      if (!document.fullscreenElement) {
        this.vncIframeRef.nativeElement.requestFullscreen();
      } else {
        document.exitFullscreen();
      }
    }
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

  private handleFullscreenChange = (): void => {
    this.isFullscreen.set(!!document.fullscreenElement);
  };

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
    console.log('VNC iframe loaded');
    // Clear the connection timeout since we got a proper load event
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    this.connectionState.set(VncConnectionState.Connected);
    this.error.set(null);
  }

  onIframeError(): void {
    console.error('VNC iframe failed to load');
    this.connectionState.set(VncConnectionState.Error);
    this.error.set('Failed to load VNC viewer. Check your VPS connection.');
  }

  // Keyboard shortcuts
  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.dockPosition() !== 'minimized') {
      this.toggleMinimize();
    }
  }
}
