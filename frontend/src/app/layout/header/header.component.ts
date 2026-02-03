import { Component, signal, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ThemeService } from '../../core/services/theme.service';

/**
 * Top header component with mobile menu toggle and theme switcher
 */
@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './header.component.html',
  styleUrl: './header.component.css'
})
export class HeaderComponent {
  sidebarOpen = signal(false);
  toggleSidebar = output<void>();

  constructor(public themeService: ThemeService) {}

  onToggleSidebar(): void {
    this.sidebarOpen.set(!this.sidebarOpen());
    this.toggleSidebar.emit();
  }

  toggleTheme(): void {
    this.themeService.toggle();
  }
}
