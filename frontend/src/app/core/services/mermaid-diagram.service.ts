import { Injectable } from '@angular/core';
import mermaid from 'mermaid';

const darkThemeConfig = {
  theme: 'dark' as const,
  themeVariables: {
    primaryColor: '#8b5cf6',
    primaryTextColor: '#e6edf3',
    primaryBorderColor: '#6366f1',
    lineColor: '#8b949e',
    secondaryColor: '#21262d',
    tertiaryColor: '#161b22',
    background: '#0d1117',
    mainBkg: '#161b22',
    secondBkg: '#21262d',
    nodeBorder: '#6366f1',
    clusterBkg: '#21262d',
    clusterBorder: '#30363d',
    titleColor: '#e6edf3',
    edgeLabelBackground: '#21262d',
    nodeTextColor: '#e6edf3',
  },
};

const lightThemeConfig = {
  theme: 'default' as const,
  themeVariables: {
    primaryColor: '#8b5cf6',
    primaryTextColor: '#24292f',
    primaryBorderColor: '#6366f1',
    lineColor: '#57606a',
    secondaryColor: '#f6f8fa',
    tertiaryColor: '#ffffff',
    background: '#ffffff',
    mainBkg: '#f6f8fa',
    secondBkg: '#eaeef2',
    nodeBorder: '#6366f1',
    clusterBkg: '#f6f8fa',
    clusterBorder: '#d0d7de',
    titleColor: '#24292f',
    edgeLabelBackground: '#f6f8fa',
    nodeTextColor: '#24292f',
  },
};

function getCurrentTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function initMermaidWithTheme(): void {
  const isDark = getCurrentTheme() === 'dark';
  const themeConfig = isDark ? darkThemeConfig : lightThemeConfig;
  mermaid.initialize({
    startOnLoad: false,
    ...themeConfig,
    flowchart: { curve: 'basis', padding: 15 },
    securityLevel: 'loose',
  });
}

/**
 * Re-initialize Mermaid with current theme. Exported for use by MarkdownPipe.
 */
export function initMermaidForRender(): void {
  initMermaidWithTheme();
}

/**
 * Service to re-render Mermaid diagrams when theme changes.
 * Diagrams are baked with theme colors at render time, so we must re-render
 * when switching between light/dark mode.
 */
@Injectable({ providedIn: 'root' })
export class MermaidDiagramService {
  /**
   * Re-render all Mermaid diagrams on the page with the current theme.
   * Call this when the theme changes (e.g. from ThemeService).
   */
  rerenderAllDiagrams(): void {
    setTimeout(() => this.doRerender(), 50);
  }

  /**
   * Post-process rendered diagrams: fix .label-container fill in dark mode
   * (Mermaid outputs inline style="fill:#e1f5fe !important" which CSS cannot override)
   */
  postProcessLabelContainers(): void {
    if (getCurrentTheme() !== 'dark') return;
    const darkFill = '#21262d';
    document.querySelectorAll('.mermaid .label-container, .mermaid rect.label-container, .mermaid rect.basic.label-container').forEach((el) => {
      if (el instanceof SVGElement) {
        el.setAttribute('style', `fill:${darkFill} !important`);
      }
    });
  }

  private doRerender(): void {
    const wrappers = document.querySelectorAll('.mermaid-wrapper[data-mermaid-source]');
    if (wrappers.length === 0) return;

    initMermaidWithTheme();

    wrappers.forEach((wrapper) => {
      const sourceAttr = wrapper.getAttribute('data-mermaid-source');
      if (!sourceAttr) return;

      const mermaidEl = wrapper.querySelector('.mermaid');
      if (!mermaidEl) return;

      try {
        const source = decodeURIComponent(atob(sourceAttr));
        mermaidEl.removeAttribute('data-processed');
        mermaidEl.textContent = source;

        mermaid.run({ nodes: [mermaidEl as HTMLElement] }).then(() => {
          this.postProcessLabelContainers();
        }).catch((e) => {
          console.warn('Mermaid re-render failed:', e);
        });
      } catch (e) {
        console.warn('Failed to decode/render mermaid diagram:', e);
      }
    });
  }
}
