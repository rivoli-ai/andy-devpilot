import { Component, signal, output, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ThemeService } from '../../core/services/theme.service';
import { VncViewerService } from '../../core/services/vnc-viewer.service';
import { Subscription } from 'rxjs';

/**
 * Top header component with mobile menu toggle, sandbox indicator, and theme switcher
 */
@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './header.component.html',
  styleUrl: './header.component.css'
})
export class HeaderComponent implements OnInit, OnDestroy {
  readonly MAX_SANDBOXES = 5;
  sidebarOpen = signal(false);
  toggleSidebar = output<void>();
  sandboxCount = signal(0);
  private sub?: Subscription;

  constructor(
    public themeService: ThemeService,
    private vncViewerService: VncViewerService
  ) {}

  ngOnInit(): void {
    this.sandboxCount.set(this.vncViewerService.viewers.length);
    this.sub = this.vncViewerService.viewers$.subscribe(viewers => {
      this.sandboxCount.set(viewers.length);
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  get atCapacity(): boolean {
    return this.sandboxCount() >= this.MAX_SANDBOXES;
  }

  closeAllSandboxes(): void {
    this.vncViewerService.closeAll();
  }

  onToggleSidebar(): void {
    this.sidebarOpen.set(!this.sidebarOpen());
    this.toggleSidebar.emit();
  }

  toggleTheme(): void {
    this.themeService.toggle();
  }
}
