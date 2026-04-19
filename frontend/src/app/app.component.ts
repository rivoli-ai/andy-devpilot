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
import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { MermaidModalComponent } from './components/mermaid-modal/mermaid-modal.component';
import { VncViewerService, VncViewer } from './core/services/vnc-viewer.service';
import { SandboxService, Sandbox } from './core/services/sandbox.service';
// VNC URLs now come from the sandbox manager proxy
import { AuthService } from './core/services/auth.service';
import { CommonModule, DOCUMENT } from '@angular/common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    SidebarComponent,
    HeaderComponent,
    VncViewerComponent,
    DockPanelComponent,
    ToastComponent,
    ConfirmDialogComponent,
    MermaidModalComponent,
    CommonModule
  ],
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
  private dockResizeRafId = 0;

  readonly sandboxDockRegion = viewChild<ElementRef<HTMLElement>>('sandboxDockRegion');

  /** Short-lived set of sandbox ids playing the “promoted to front” animation */
  dockPromotingIds = signal<ReadonlySet<string>>(new Set());

  private prevMinimizedReadyById = new Map<string, boolean>();
  private dockReadyTrackingInitialized = false;

  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
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
    destroyRef.onDestroy(() => {
      this.teardownDockResizeObserver();
      this.document.documentElement.classList.remove('devpilot-workspace-scroll-lock');
    });

    effect(() => {
      const lock =
        this.authService.isAuthenticated() &&
        this.authService.token() !== null &&
        this.sandboxUiAllowed();
      this.document.documentElement.classList.toggle('devpilot-workspace-scroll-lock', lock);
    });

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
    this.vncViewers().filter(v => v.dockPosition === 'tiled' && !v.hideMinimizedTray)
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
    const list = all.filter(v => v.dockPosition === 'minimized' && !v.hideMinimizedTray);
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
    this.vncViewers().filter(v => v.dockPosition === 'right' && !v.hideMinimizedTray)
  );

  // Computed: viewers docked to the bottom
  bottomDockedViewers = computed(() =>
    this.vncViewers().filter(v => v.dockPosition === 'bottom' && !v.hideMinimizedTray)
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
        const tiled = viewers.filter(
          v => v.dockPosition === 'tiled' && !v.hideMinimizedTray
        ).length;
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
    const minimized = viewers.filter(v => v.dockPosition === 'minimized' && !v.hideMinimizedTray);

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
    if (this.dockResizeRafId) {
      cancelAnimationFrame(this.dockResizeRafId);
      this.dockResizeRafId = 0;
    }
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
    if (this.dockResizeRafId) {
      cancelAnimationFrame(this.dockResizeRafId);
      this.dockResizeRafId = 0;
    }
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

    // Coalesce ResizeObserver callbacks to the next frame to avoid nested
    // layout loops with noVNC/iframes (Chrome "ResizeObserver loop" warnings).
    this.dockResizeObserver = new ResizeObserver(() => {
      if (this.dockResizeRafId) {
        cancelAnimationFrame(this.dockResizeRafId);
      }
      this.dockResizeRafId = requestAnimationFrame(() => {
        this.dockResizeRafId = 0;
        measure();
      });
    });
    this.dockResizeObserver.observe(footprintEl);
    measure();
  }

  /**
   * Restore VNC dock viewers from the API + localStorage after refresh.
   * Only opens a viewer when {@link VncViewerService.getStoredContext} exists (user had opened
   * that sandbox in the dock). Code Ask auxiliary desktop is never auto-opened here — user opens
   * it from Code › Open desktop; stored context still keeps VNC password/title for that action.
   */
  private restoreRunningSandboxes(): void {
    this.sandboxService.listSandboxes().subscribe({
      next: (sandboxes: Sandbox[]) => {
        if (sandboxes.length === 0) return;
        console.log('Restoring running sandbox(es), checking stored context...');
        sandboxes.forEach(sandbox => {
          const stored = this.vncViewerService.getStoredContext(sandbox.id);
          // Only re-open the VNC dock when we have stored context (user had this viewer open).
          // Code Ask often runs without ever opening the desktop viewer, so there is no stored
          // context — we must NOT delete the sandbox here; that was incorrectly treating Ask-only
          // sessions as orphans and stopped the container on every full page refresh.
          if (!stored) {
            console.log(
              'Skipping VNC restore (no local viewer context; sandbox may still be in use e.g. Ask):',
              sandbox.id.slice(0, 8)
            );
            return;
          }
          if (this.vncViewerService.resolveStoredHideMinimizedTray(stored)) {
            console.log(
              'Skipping VNC restore (Code Ask desktop — open from Code when needed):',
              sandbox.id.slice(0, 8)
            );
            return;
          }
          const title = stored.title ?? `Sandbox ${sandbox.id.slice(0, 6)}`;
          this.vncViewerService.open(
            sandbox.id,
            title,
            stored.implementationContext ?? undefined,
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

  closeMobileSidebar(): void {
    this.sidebarOpen.set(false);
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
    const v = this.vncViewerService.getViewer(viewerId);
    if (v?.hideMinimizedTray) {
      this.vncViewerService.dismissViewerKeepSandbox(viewerId);
      return;
    }
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
