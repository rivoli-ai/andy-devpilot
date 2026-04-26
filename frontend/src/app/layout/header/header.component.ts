import {
  Component,
  signal,
  output,
  OnInit,
  OnDestroy,
  HostListener,
  ElementRef,
  viewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ThemeService } from '../../core/services/theme.service';
import { VncViewerService, VncViewer } from '../../core/services/vnc-viewer.service';
import { CodeAskBinding, SandboxService } from '../../core/services/sandbox.service';
import { combineLatest, merge, of, Subscription, timer } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { BreadcrumbComponent } from '../breadcrumb/breadcrumb.component';

/** One row in the header “running sandboxes” dropdown. */
export interface HeaderRunningSandboxRow {
  id: string;
  label: string;
  hasViewer: boolean;
  isCodeAsk: boolean;
}

/**
 * Top header component with mobile menu toggle, sandbox indicator, and theme switcher
 */
@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, BreadcrumbComponent],
  templateUrl: './header.component.html',
  styleUrl: './header.component.css'
})
export class HeaderComponent implements OnInit, OnDestroy {
  readonly MAX_SANDBOXES = 5;
  sidebarOpen = signal(false);
  toggleSidebar = output<void>();
  /** Unique running sandboxes (VNC tiles + headless Code → Ask, deduped by id). */
  runningSandboxes = signal<HeaderRunningSandboxRow[]>([]);
  sandboxMenuOpen = signal(false);
  private sub?: Subscription;
  private readonly sandboxWidget = viewChild<ElementRef<HTMLElement>>('sandboxWidget');

  constructor(
    public themeService: ThemeService,
    private vncViewerService: VncViewerService,
    private sandboxService: SandboxService
  ) {}

  /** Polled; merge `of([])` so the header can use client fallback before the first request completes. */
  private readonly askBindings$ = merge(
    of([] as CodeAskBinding[]),
    timer(0, 20_000).pipe(switchMap(() => this.sandboxService.listCodeAskBindings()))
  );

  ngOnInit(): void {
    this.sub = combineLatest([
      this.vncViewerService.viewers$,
      this.sandboxService.codeAskActiveSandboxId$,
      this.sandboxService.codeAskActiveRepositoryLabel$,
      this.askBindings$
    ])
      .pipe(
        map(([viewers, codeAskId, codeAskRepoLabel, askBindings]) =>
          this.buildRows(viewers, codeAskId, codeAskRepoLabel, askBindings)
        )
      )
      .subscribe(rows => this.runningSandboxes.set(rows));
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private buildRows(
    viewers: VncViewer[],
    codeAskId: string | null,
    codeAskRepoLabel: string | null,
    askBindings: CodeAskBinding[]
  ): HeaderRunningSandboxRow[] {
    const byId = new Map<string, HeaderRunningSandboxRow>();
    for (const v of viewers) {
      byId.set(v.id, {
        id: v.id,
        label: (v.title && v.title.trim()) || this.shortId(v.id),
        hasViewer: true,
        isCodeAsk: false
      });
    }

    if (askBindings.length > 0) {
      for (const b of askBindings) {
        const askLabel = `${b.repositoryName} · ${b.branch} · Ask`;
        const existing = byId.get(b.sandboxId);
        if (existing) {
          existing.isCodeAsk = true;
          existing.label = askLabel;
        } else {
          byId.set(b.sandboxId, {
            id: b.sandboxId,
            label: askLabel,
            hasViewer: false,
            isCodeAsk: true
          });
        }
      }
      if (codeAskId && !byId.has(codeAskId)) {
        this.mergeSingleCodeAskRow(byId, codeAskId, codeAskRepoLabel);
      }
    } else if (codeAskId) {
      this.mergeSingleCodeAskRow(byId, codeAskId, codeAskRepoLabel);
    }

    return Array.from(byId.values());
  }

  private mergeSingleCodeAskRow(
    byId: Map<string, HeaderRunningSandboxRow>,
    codeAskId: string,
    codeAskRepoLabel: string | null
  ): void {
    const askLabel = codeAskRepoLabel ? `${codeAskRepoLabel} · Ask` : 'Code → Ask';
    const existing = byId.get(codeAskId);
    if (existing) {
      existing.isCodeAsk = true;
      existing.label = askLabel;
    } else {
      byId.set(codeAskId, {
        id: codeAskId,
        label: askLabel,
        hasViewer: false,
        isCodeAsk: true
      });
    }
  }

  private shortId(id: string): string {
    if (id.length <= 10) {
      return id;
    }
    return `${id.slice(0, 6)}…${id.slice(-4)}`;
  }

  sandboxCount(): number {
    return this.runningSandboxes().length;
  }

  /** e.g. "1 sandbox running" or "2 sandboxes running" */
  sandboxRunningLabel(): string {
    const n = this.sandboxCount();
    if (n === 1) {
      return '1 sandbox running';
    }
    return `${n} sandboxes running`;
  }

  get atCapacity(): boolean {
    return this.sandboxCount() >= this.MAX_SANDBOXES;
  }

  toggleSandboxMenu(event: Event): void {
    event.stopPropagation();
    this.sandboxMenuOpen.update(o => !o);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event): void {
    if (!this.sandboxMenuOpen()) {
      return;
    }
    const host = this.sandboxWidget()?.nativeElement;
    if (host && event.target instanceof Node && host.contains(event.target)) {
      return;
    }
    this.sandboxMenuOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.sandboxMenuOpen.set(false);
  }

  closeRow(row: HeaderRunningSandboxRow, event?: Event): void {
    event?.stopPropagation();
    this.sandboxMenuOpen.set(false);

    const isActiveAsk = this.sandboxService.getCodeAskActiveSandboxId() === row.id;

    if (row.isCodeAsk && isActiveAsk) {
      this.sandboxService.requestReleaseCodeChatSandbox(row.id);
      return;
    }

    if (row.hasViewer) {
      this.vncViewerService.close(row.id);
      return;
    }

    this.sandboxService.deleteSandbox(row.id).subscribe();
  }

  closeAllSandboxes(): void {
    for (const row of this.runningSandboxes()) {
      const isActiveAsk = this.sandboxService.getCodeAskActiveSandboxId() === row.id;
      if (row.isCodeAsk && isActiveAsk) {
        this.sandboxService.requestReleaseCodeChatSandbox(row.id);
      } else if (row.hasViewer) {
        this.vncViewerService.close(row.id);
      } else {
        this.sandboxService.deleteSandbox(row.id).subscribe();
      }
    }
    this.sandboxMenuOpen.set(false);
  }

  onToggleSidebar(): void {
    this.sidebarOpen.set(!this.sidebarOpen());
    this.toggleSidebar.emit();
  }

  toggleTheme(): void {
    this.themeService.toggle();
  }
}
