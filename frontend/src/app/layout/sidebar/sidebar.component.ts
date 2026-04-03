import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

/**
 * Modern sidebar navigation component
 */
@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.css'
})
export class SidebarComponent {
  /** Narrow icon rail when true */
  isCollapsed = input(false);
  /** Mobile drawer open state */
  mobileOpen = input(false);

  collapseToggled = output<void>();
  /** Close the mobile drawer after choosing a destination */
  mobileDrawerClose = output<void>();

  constructor(
    public authService: AuthService,
    private router: Router
  ) {}

  onToggleCollapse(): void {
    this.collapseToggled.emit();
  }

  onMobileNavLinkClick(): void {
    if (this.mobileOpen()) {
      this.mobileDrawerClose.emit();
    }
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  /** Repos list + repo-scoped backlog/code live outside `/repositories/*` in the router. */
  repositoriesNavActive(): boolean {
    const path = this.router.url.split('?')[0].split('#')[0];
    return (
      path === '/repositories' ||
      path.startsWith('/repositories/') ||
      path.startsWith('/backlog/') ||
      path.startsWith('/code/')
    );
  }
}
