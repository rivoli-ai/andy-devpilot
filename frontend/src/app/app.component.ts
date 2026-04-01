import {
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { Subscription, filter, map } from 'rxjs';
import { SidebarComponent } from './layout/sidebar/sidebar.component';
import { HeaderComponent } from './layout/header/header.component';
import { ThemeService } from './core/services/theme.service';
import { VncViewerComponent } from './components/vnc-viewer/vnc-viewer.component';
import { DockPanelComponent } from './components/dock-panel/dock-panel.component';
import { ToastComponent } from './components/toast/toast.component';
import { VncViewerService, VncViewer } from './core/services/vnc-viewer.service';
import { SandboxService, Sandbox } from './core/services/sandbox.service';
import { getVncHtmlUrl } from './core/config/vps.config';
import { AuthService } from './core/services/auth.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, HeaderComponent, VncViewerComponent, DockPanelComponent, ToastComponent, CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, OnDestroy {
  private static readonly SIDEBAR_COLLAPSED_KEY = 'devpilot-sidebar-collapsed';

  sidebarCollapsed = signal(this.readSidebarCollapsedPreference());
  sidebarOpen = signal(false);
  vncViewers = signal<VncViewer[]>([]);
  /** Dock-mode (tiled) panel above the page */
  sandboxDockTiledExpanded = signal(false);
  /** Minimized chips under the pin row (collapsed = pin + count only) */
  sandboxDockFootprintExpanded = signal(false);
  
  private subscriptions: Subscription[] = [];
  private lastTiledCount = 0;
  private dockResizeObserver: ResizeObserver | null = null;

  readonly sandboxDockRegion = viewChild<ElementRef<HTMLElement>>('sandboxDockRegion');

  /** Short-lived set of sandbox ids playing the “promoted to front” animation */
  dockPromotingIds = signal<ReadonlySet<string>>(new Set());

  private prevMinimizedReadyById = new Map<string, boolean>();
  private dockReadyTrackingInitialized = false;

  private readonly router = inject(Router);
  private readonly routerUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(e => e.urlAfterRedirects)
    ),
    { initialValue: this.router.url }
  );

  /** Dock tray / floating viewers / side dock panels — only on backlog & code routes */
  sandboxUiAllowed = computed(() => {
    const path = (this.routerUrl() ?? '').split('?')[0];
    return path.includes('/backlog/') || path.includes('/code/');
  });

  // Check if user is authenticated for showing sidebar/header
  isAuthenticated = computed(() => this.authService.isLoggedIn());

  constructor(
    private themeService: ThemeService,
    private vncViewerService: VncViewerService,
    private sandboxService: SandboxService,
    public authService: AuthService
  ) {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.teardownDockResizeObserver());

    effect(() => {
      this.minimizedViewers().length;
      this.tiledDockViewers().length;
      this.sandboxDockTiledExpanded();
      this.sandboxDockFootprintExpanded();
      this.sandboxUiAllowed();
      queueMicrotask(() => this.syncSandboxDockHeightObserver());
    });

    effect(() => {
      this.trackMinimizedReadyForPromotion();
    });
  }

  /** Free draggable windows (not in full-screen dock) */
  floatingViewers = computed(() =>
    this.vncViewers().filter(v => v.dockPosition === 'floating')
  );

  /** Tiled “dock mode” viewers — shown in the bottom sandbox tray (main column) */
  tiledDockViewers = computed(() =>
    this.vncViewers().filter(v => v.dockPosition === 'tiled')
  );

  /** Tray visible: bottom bar + expandable area (minimized chips and/or tiled dock) */
  sandboxDockTrayVisible = computed(
    () => this.minimizedViewers().length > 0 || this.tiledDockViewers().length > 0
  );

  sandboxDockTrayTotal = computed(
    () => this.minimizedViewers().length + this.tiledDockViewers().length
  );

  /**
   * Pin chevron: minimized strip when there are minimized viewers; otherwise tiled panel (tiles-only).
   */
  dockPinChevronOpen = computed(() => {
    if (this.minimizedViewers().length > 0) {
      return this.sandboxDockFootprintExpanded();
    }
    if (this.tiledDockViewers().length > 0) {
      return this.sandboxDockTiledExpanded();
    }
    return false;
  });

  // Computed: minimized viewers — PR-ready first, then prior app order
  minimizedViewers = computed(() => {
    const all = this.vncViewers();
    const order = new Map(all.map((v, i) => [v.id, i]));
    const list = all.filter(v => v.dockPosition === 'minimized');
    return [...list].sort((a, b) => {
      const ar = a.readyForPr === true ? 1 : 0;
      const br = b.readyForPr === true ? 1 : 0;
      if (br !== ar) {
        return br - ar;
      }
      return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    });
  });

  // Computed: viewers docked to the right
  rightDockedViewers = computed(() => 
    this.vncViewers().filter(v => v.dockPosition === 'right')
  );

  // Computed: viewers docked to the bottom
  bottomDockedViewers = computed(() => 
    this.vncViewers().filter(v => v.dockPosition === 'bottom')
  );

  ngOnInit(): void {
    // Initialize theme on app start
    this.themeService.setTheme(this.themeService.theme());

    // Subscribe to VNC viewers
    this.subscriptions.push(
      this.vncViewerService.viewers$.subscribe(viewers => {
        console.log('AppComponent received viewers update:', viewers.length);
        this.vncViewers.set(viewers);
        const minimized = viewers.filter(v => v.dockPosition === 'minimized').length;
        const tiled = viewers.filter(v => v.dockPosition === 'tiled').length;
        if (minimized === 0 && tiled === 0) {
          this.sandboxDockTiledExpanded.set(false);
          this.sandboxDockFootprintExpanded.set(false);
        } else if (tiled > this.lastTiledCount) {
          this.sandboxDockTiledExpanded.set(true);
        }
        if (tiled === 0 && this.lastTiledCount > 0) {
          this.sandboxDockTiledExpanded.set(false);
        }
        this.lastTiledCount = tiled;
      })
    );

    // Subscribe to viewer closed events to cleanup sandboxes
    this.subscriptions.push(
      this.vncViewerService.viewerClosed$.subscribe(sandboxId => {
        console.log('Viewer closed, deleting sandbox:', sandboxId);
        this.sandboxService.deleteSandbox(sandboxId).subscribe({
          next: (success) => {
            if (success) {
              console.log('Sandbox deleted successfully:', sandboxId);
            } else {
              console.warn('Failed to delete sandbox:', sandboxId);
            }
          },
          error: (err) => console.error('Error deleting sandbox:', err)
        });
      })
    );

    // Restore running sandboxes so they survive page refresh
    this.restoreRunningSandboxes();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.teardownDockResizeObserver();
  }

  private trackMinimizedReadyForPromotion(): void {
    const viewers = this.vncViewers();
    const minimized = viewers.filter(v => v.dockPosition === 'minimized');

    if (!this.dockReadyTrackingInitialized) {
      for (const v of minimized) {
        this.prevMinimizedReadyById.set(v.id, v.readyForPr === true);
      }
      this.dockReadyTrackingInitialized = true;
      return;
    }

    for (const v of minimized) {
      const was = this.prevMinimizedReadyById.get(v.id) ?? false;
      const now = v.readyForPr === true;
      if (now && !was) {
        this.flashDockPrReadyPromotion(v.id);
      }
      this.prevMinimizedReadyById.set(v.id, now);
    }

    const alive = new Set(minimized.map(v => v.id));
    for (const id of [...this.prevMinimizedReadyById.keys()]) {
      if (!alive.has(id)) {
        this.prevMinimizedReadyById.delete(id);
      }
    }
  }

  private flashDockPrReadyPromotion(sandboxId: string): void {
    this.sandboxDockFootprintExpanded.set(true);
    this.dockPromotingIds.update(s => new Set([...s, sandboxId]));
    window.setTimeout(() => {
      this.dockPromotingIds.update(s => {
        const next = new Set(s);
        next.delete(sandboxId);
        return next;
      });
    }, 520);
  }

  private teardownDockResizeObserver(): void {
    this.dockResizeObserver?.disconnect();
    this.dockResizeObserver = null;
    document.documentElement.style.removeProperty('--sandbox-dock-footprint-height');
  }

  /**
   * Publishes the sandbox footprint bar height (px) on :root for CSS.
   * Open dock panel height and main padding-bottom share one formula in CSS
   * (.sandbox-dock-tiled-open) so the column does not overflow the viewport.
   */
  private syncSandboxDockHeightObserver(): void {
    this.dockResizeObserver?.disconnect();
    this.dockResizeObserver = null;

    if (!this.sandboxUiAllowed() || !this.sandboxDockTrayVisible()) {
      document.documentElement.style.removeProperty('--sandbox-dock-footprint-height');
      return;
    }

    const footprintEl = this.sandboxDockRegion()?.nativeElement;
    if (!footprintEl) {
      return;
    }

    const measure = () => {
      const footprintH = Math.max(0, Math.round(footprintEl.getBoundingClientRect().height));
      document.documentElement.style.setProperty('--sandbox-dock-footprint-height', `${footprintH}px`);
    };

    this.dockResizeObserver = new ResizeObserver(() => measure());
    this.dockResizeObserver.observe(footprintEl);
    measure();
  }

  /**
   * Restore running sandboxes from the API and open viewers so they survive page refresh.
   * Only restores sandboxes that have stored context (opened in this session before refresh).
   * Sandboxes the user closed had their context removed, so they are not restored (avoids ghost viewers).
   */
  private restoreRunningSandboxes(): void {
    this.sandboxService.listSandboxes().subscribe({
      next: (sandboxes: Sandbox[]) => {
        if (sandboxes.length === 0) return;
        console.log('Restoring running sandbox(es), checking stored context...');
        sandboxes.forEach(sandbox => {
          const stored = this.vncViewerService.getStoredContext(sandbox.id);
          // Only restore if we have stored context (user had this viewer open before refresh).
          // If user closed the viewer we removed context, so skip to avoid ghost sandbox.
          if (!stored) {
            console.log('Skipping sandbox (no stored context, likely closed by user):', sandbox.id.slice(0, 8));
            this.sandboxService.deleteSandbox(sandbox.id).subscribe({
              next: (ok) => { if (ok) console.log('Cleaned up orphan sandbox:', sandbox.id.slice(0, 8)); },
              error: () => {}
            });
            return;
          }
          const config = {
            url: stored.vncUrl || getVncHtmlUrl(sandbox.port),
            autoConnect: true,
            scalingMode: 'local' as const,
            useIframe: true
          };
          const title = stored.title ?? `Sandbox ${sandbox.id.slice(0, 6)}`;
          const bridgePort = stored.bridgePort ?? sandbox.bridge_port;
          this.vncViewerService.open(
            config,
            sandbox.id,
            title,
            bridgePort,
            stored.implementationContext ?? undefined,
            stored.sandboxToken,
            stored.bridgeUrl,
            stored.vncPassword
          );
        });
      },
      error: (err) => console.warn('Could not list sandboxes for restore:', err)
    });
  }

  toggleSidebar(): void {
    this.sidebarOpen.update(open => !open);
  }

  toggleSidebarCollapsed(): void {
    this.sidebarCollapsed.update(collapsed => {
      const next = !collapsed;
      try {
        localStorage.setItem(AppComponent.SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* ignore quota / private mode */
      }
      return next;
    });
  }

  private readSidebarCollapsedPreference(): boolean {
    try {
      const v = localStorage.getItem(AppComponent.SIDEBAR_COLLAPSED_KEY);
      if (v === null) {
        return false;
      }
      return v === '1' || v === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Pin toggles the minimized chip strip only when there are minimized viewers.
   * When there are only tiled dock viewers: expand shows tiles; collapse minimizes all to chips.
   */
  onSandboxDockPinClick(): void {
    if (this.minimizedViewers().length > 0) {
      this.sandboxDockFootprintExpanded.update(e => !e);
      return;
    }
    if (this.tiledDockViewers().length > 0) {
      if (this.sandboxDockTiledExpanded()) {
        this.collapseTiledDockToMinimized();
      } else {
        this.sandboxDockTiledExpanded.set(true);
      }
    }
  }

  /**
   * Closing the expanded dock (header control or pin) sends every tiled sandbox to minimized chips.
   */
  onSandboxDockTiledPanelCollapse(): void {
    this.collapseTiledDockToMinimized();
  }

  private collapseTiledDockToMinimized(): void {
    if (this.tiledDockViewers().length === 0) {
      this.sandboxDockTiledExpanded.set(false);
      return;
    }
    this.vncViewerService.minimizeAllTiled();
    this.sandboxDockTiledExpanded.set(false);
    this.sandboxDockFootprintExpanded.set(false);
  }

  sandboxDockPinSubline(): string {
    if (this.minimizedViewers().length > 0) {
      return this.sandboxDockFootprintExpanded()
        ? 'Tap to collapse minimized sandboxes'
        : 'Tap to expand minimized sandboxes';
    }
    if (this.tiledDockViewers().length > 0) {
      return this.sandboxDockTiledExpanded()
        ? 'Tap to minimize sandboxes to tray'
        : 'Tap to show dock tiles above';
    }
    return '';
  }

  sandboxDockPinAriaControls(): string | null {
    if (this.minimizedViewers().length > 0) {
      return this.sandboxDockFootprintExpanded() ? 'sandbox-dock-minimized-chrome' : null;
    }
    if (this.tiledDockViewers().length > 0) {
      return 'sandbox-dock-body';
    }
    return null;
  }

  onVncViewerClose(viewerId: string): void {
    this.vncViewerService.close(viewerId);
  }

  onViewerUndocked(viewerId: string): void {
    this.vncViewerService.setDockPosition(viewerId, 'floating');
  }

  onViewerMinimized(viewerId: string): void {
    this.vncViewerService.setDockPosition(viewerId, 'minimized');
  }

  // Get CSS classes for main content based on VNC dock positions
  getContentClasses(): string {
    const classes: string[] = [];

    if (this.sidebarCollapsed()) {
      classes.push('app-sidebar-collapsed');
    }
    if (this.sandboxUiAllowed() && this.rightDockedViewers().length > 0) {
      classes.push('vnc-docked-right');
    }
    if (this.sandboxUiAllowed() && this.bottomDockedViewers().length > 0) {
      classes.push('vnc-docked-bottom');
    }
    if (this.sandboxUiAllowed()) {
      classes.push('app-workspace-view');
    }
    if (this.sandboxUiAllowed() && this.sandboxDockTrayVisible()) {
      classes.push('has-sandbox-dock');
    }
    if (
      this.sandboxUiAllowed() &&
      this.tiledDockViewers().length > 0 &&
      this.sandboxDockTiledExpanded()
    ) {
      classes.push('sandbox-dock-tiled-open');
    }
    return classes.join(' ');
  }
}
