import { Component, signal, OnInit, OnDestroy, computed } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Subscription } from 'rxjs';
import { SidebarComponent } from './layout/sidebar/sidebar.component';
import { HeaderComponent } from './layout/header/header.component';
import { ThemeService } from './core/services/theme.service';
import { VncViewerComponent } from './components/vnc-viewer/vnc-viewer.component';
import { DockPanelComponent } from './components/dock-panel/dock-panel.component';
import { ToastComponent } from './components/toast/toast.component';
import { VncViewerService, VncViewer } from './core/services/vnc-viewer.service';
import { SandboxService } from './core/services/sandbox.service';
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
  sidebarCollapsed = signal(false);
  sidebarOpen = signal(false);
  vncViewers = signal<VncViewer[]>([]);
  
  private subscriptions: Subscription[] = [];

  // Check if user is authenticated for showing sidebar/header
  isAuthenticated = computed(() => this.authService.isLoggedIn());

  constructor(
    private themeService: ThemeService,
    private vncViewerService: VncViewerService,
    private sandboxService: SandboxService,
    public authService: AuthService
  ) {}

  // Computed: viewers that are floating
  floatingViewers = computed(() => 
    this.vncViewers().filter(v => v.dockPosition === 'floating')
  );

  // Computed: viewers that are minimized
  minimizedViewers = computed(() => 
    this.vncViewers().filter(v => v.dockPosition === 'minimized')
  );

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

    // Clean up ghost sandboxes on startup
    this.cleanupGhostSandboxes();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }

  /**
   * Clean up any sandboxes that are running but don't have a corresponding viewer
   */
  private cleanupGhostSandboxes(): void {
    this.sandboxService.listSandboxes().subscribe({
      next: (sandboxes) => {
        console.log('Found', sandboxes.length, 'running sandboxes on startup');
        const viewerIds = this.vncViewerService.viewers.map(v => v.id);
        
        // Delete sandboxes that don't have a viewer
        sandboxes.forEach(sandbox => {
          if (!viewerIds.includes(sandbox.id)) {
            console.log('Cleaning up ghost sandbox:', sandbox.id);
            this.sandboxService.deleteSandbox(sandbox.id).subscribe();
          }
        });
      },
      error: (err) => console.log('Could not check for ghost sandboxes:', err)
    });
  }

  toggleSidebar(): void {
    this.sidebarOpen.update(open => !open);
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
    
    if (this.rightDockedViewers().length > 0) {
      classes.push('vnc-docked-right');
    }
    if (this.bottomDockedViewers().length > 0) {
      classes.push('vnc-docked-bottom');
    }
    
    return classes.join(' ');
  }
}
