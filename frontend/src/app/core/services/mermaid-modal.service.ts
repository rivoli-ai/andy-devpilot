import { Injectable, signal } from '@angular/core';

export interface MermaidModalOpenState {
  /** Raw mermaid source */
  source: string;
  /** Same encoding as markdown pipe / data-mermaid-source (for theme re-render) */
  encoded: string;
}

/**
 * Full-screen / large modal for Mermaid diagrams with pan & zoom.
 * Opened via document click on `.mermaid-expand-btn` (injected by MarkdownPipe).
 */
@Injectable({ providedIn: 'root' })
export class MermaidModalService {
  readonly openState = signal<MermaidModalOpenState | null>(null);

  constructor() {
    if (typeof document === 'undefined') {
      return;
    }
    document.addEventListener('click', this.onDocumentClick, true);
  }

  private onDocumentClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const btn = target?.closest?.('.mermaid-expand-btn');
    if (!btn) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const wrapper = btn.closest('.mermaid-wrapper[data-mermaid-source]');
    const encoded = wrapper?.getAttribute('data-mermaid-source');
    if (!encoded) {
      return;
    }
    try {
      const source = decodeURIComponent(atob(encoded));
      this.open(source, encoded);
    } catch {
      /* ignore invalid base64 */
    }
  };

  open(source: string, encoded?: string): void {
    this.openState.set({
      source,
      encoded: encoded ?? btoa(encodeURIComponent(source)),
    });
  }

  close(): void {
    this.openState.set(null);
  }
}
