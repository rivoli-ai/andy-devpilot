import { Injectable, signal, effect } from '@angular/core';

export type Theme = 'light' | 'dark';

/**
 * Service for managing theme (light/dark mode)
 */
@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private readonly themeKey = 'devpilot-theme';
  private _theme = signal<Theme>(this.getInitialTheme());

  readonly theme = this._theme.asReadonly();

  constructor() {
    // Apply theme on initialization and changes
    effect(() => {
      const theme = this._theme();
      this.applyTheme(theme);
      localStorage.setItem(this.themeKey, theme);
    });
  }

  private getInitialTheme(): Theme {
    const saved = localStorage.getItem(this.themeKey) as Theme;
    if (saved && (saved === 'light' || saved === 'dark')) {
      return saved;
    }
    // Default to system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  toggle(): void {
    this._theme.update(current => current === 'light' ? 'dark' : 'light');
  }

  setTheme(theme: Theme): void {
    this._theme.set(theme);
  }

  private applyTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
    if (theme === 'dark') {
      document.body.classList.add('dark-theme');
      document.body.classList.remove('light-theme');
    } else {
      document.body.classList.add('light-theme');
      document.body.classList.remove('dark-theme');
    }
  }
}
