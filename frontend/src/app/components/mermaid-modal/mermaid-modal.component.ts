import { CommonModule } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Injector,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  afterNextRender,
} from '@angular/core';
import mermaid from 'mermaid';
import { initMermaidForRender, MermaidDiagramService } from '../../core/services/mermaid-diagram.service';
import { MermaidModalService } from '../../core/services/mermaid-modal.service';

@Component({
  selector: 'app-mermaid-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './mermaid-modal.component.html',
  styleUrl: './mermaid-modal.component.css',
})
export class MermaidModalComponent {
  private static seq = 0;

  /** Avoid re-running open logic while the dialog stays open (was resetting zoom to 1). */
  private modalSessionOpen = false;

  private readonly modal = inject(MermaidModalService);
  private readonly mermaidDiagram = inject(MermaidDiagramService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  readonly state = this.modal.openState;
  readonly diagramId = signal('mermaid-modal-0');

  readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');

  zoom = signal(1);
  panX = signal(0);
  panY = signal(0);

  readonly dragging = signal(false);
  private lastPointerX = 0;
  private lastPointerY = 0;

  /** Single transform: pan + scale (reliable across browsers; CSS `zoom` + split effects were flaky). */
  readonly stageTransform = computed(
    () => `translate(${this.panX()}px, ${this.panY()}px) scale(${this.zoom()})`
  );

  constructor() {
    effect(() => {
      const s = this.modal.openState();
      if (!s) {
        this.modalSessionOpen = false;
        this.detachWheelListener();
        this.dragging.set(false);
        this.zoom.set(1);
        this.panX.set(0);
        this.panY.set(0);
        return;
      }

      // Only init once per open — prevents spurious effect re-runs from resetting zoom mid-session.
      if (this.modalSessionOpen) {
        return;
      }
      this.modalSessionOpen = true;

      this.zoom.set(1);
      this.panX.set(0);
      this.panY.set(0);
      this.diagramId.set(`mermaid-modal-${++MermaidModalComponent.seq}`);

      afterNextRender(
        () => {
          this.renderMermaid(s.source);
          this.attachWheelListener();
        },
        { injector: this.injector }
      );
    });

    this.destroyRef.onDestroy(() => this.detachWheelListener());
  }

  private wheelCleanup?: () => void;

  private attachWheelListener(): void {
    this.detachWheelListener();
    const el = this.viewport()?.nativeElement;
    if (!el) {
      return;
    }
    const handler = (e: WheelEvent): void => {
      if (!this.modal.openState()) {
        return;
      }
      e.preventDefault();
      // Trackpad pinch-zoom often sets ctrlKey; sum axes for horizontal scroll wheels
      const raw = e.deltaY + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0);
      const step = raw > 0 ? -0.12 : raw < 0 ? 0.12 : 0;
      if (step === 0) {
        return;
      }
      this.zoom.update((z) => Math.min(4, Math.max(0.2, Math.round((z + step) * 100) / 100)));
    };
    el.addEventListener('wheel', handler, { passive: false });
    this.wheelCleanup = () => el.removeEventListener('wheel', handler);
  }

  private detachWheelListener(): void {
    this.wheelCleanup?.();
    this.wheelCleanup = undefined;
  }

  private renderMermaid(source: string): void {
    const id = this.diagramId();
    const el = document.getElementById(id);
    if (!el) {
      return;
    }
    initMermaidForRender();
    el.removeAttribute('data-processed');
    el.textContent = source;
    mermaid
      .run({ nodes: [el] })
      .then(() => this.mermaidDiagram.postProcessLabelContainers())
      .catch((e) => console.warn('Mermaid modal render failed:', e));
  }

  close(): void {
    this.modal.close();
  }

  zoomIn(): void {
    this.zoom.update((z) => Math.min(4, Math.round((z + 0.2) * 100) / 100));
  }

  zoomOut(): void {
    this.zoom.update((z) => Math.max(0.2, Math.round((z - 0.2) * 100) / 100));
  }

  resetView(): void {
    this.zoom.set(1);
    this.panX.set(0);
    this.panY.set(0);
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('mermaid-modal-backdrop')) {
      this.close();
    }
  }

  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    const t = event.target as HTMLElement;
    if (t.closest('button')) {
      return;
    }
    this.dragging.set(true);
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.dragging()) {
      return;
    }
    this.panX.update((x) => x + (event.clientX - this.lastPointerX));
    this.panY.update((y) => y + (event.clientY - this.lastPointerY));
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
  }

  onPointerUp(event: PointerEvent): void {
    this.dragging.set(false);
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape' || !this.modal.openState()) {
      return;
    }
    ev.preventDefault();
    this.close();
  }
}
