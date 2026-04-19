import { Injectable, Inject } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { VncConfig } from '../../shared/models/vnc-config.model';
import { APP_CONFIG, AppConfig } from './config.service';

/** tiled = dock grid in bottom tray; floating = free window; new sandboxes start minimized */
export type DockPosition = 'floating' | 'tiled' | 'right' | 'bottom' | 'minimized';

/** Context when sandbox was opened for implementing a user story */
export interface ImplementationContext {
  repositoryId: string;
  repositoryFullName: string;
  defaultBranch: string;
  storyTitle: string;
  storyId: string;
  /** Azure DevOps work item ID (e.g. 190) - used to link PR to work item */
  azureDevOpsWorkItemId?: number;
}

export interface VncViewer {
  id: string;
  config: VncConfig;
  dockPosition: DockPosition;
  title?: string;
  createdAt: number;
  vncPassword?: string;
  implementationContext?: ImplementationContext;
  readyForPr?: boolean;
  connectionState?: string;
  viewMode?: 'sandbox' | 'split' | 'chat';
  /**
   * When true, minimize / tray collapse removes the viewer UI without placing a chip in the
   * bottom sandbox dock (container keeps running; use e.g. Code Ask “Open desktop” to show again).
   */
  hideMinimizedTray?: boolean;
}

/** Optional flags for {@link VncViewerService.open}. */
export interface OpenVncViewerOptions {
  hideMinimizedTray?: boolean;
}

/**
 * Service for managing multiple VNC viewer instances
 * Limited to MAX_SANDBOXES concurrent viewers
 */
const SANDBOX_CONTEXTS_KEY = 'devpilot_sandbox_contexts';

export interface StoredSandboxContext {
  implementationContext?: ImplementationContext;
  title?: string;
  vncPassword?: string;
  /** Persisted so Code Ask desktop survives refresh without rejoining the Sandboxes dock. */
  hideMinimizedTray?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class VncViewerService {
  private readonly MAX_SANDBOXES = 5;
  private readonly apiUrl: string;

  private viewersSubject = new BehaviorSubject<VncViewer[]>([]);
  private viewerClosedSubject = new Subject<string>();

  viewers$: Observable<VncViewer[]> = this.viewersSubject.asObservable();
  viewerClosed$: Observable<string> = this.viewerClosedSubject.asObservable();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.apiUrl = config.apiUrl;
  }

  /**
   * Build the proxied VNC iframe URL for a given sandbox ID.
   * noVNC static files are served through /api/sandboxes/{id}/vnc/…
   * and websockify goes through /api/sandboxes/{id}/vnc/websockify.
   */
  buildVncUrl(sandboxId: string, vncPassword?: string): string {
    const wsPath = `api/sandboxes/${sandboxId}/vnc/websockify`;
    let url = `${this.apiUrl}/sandboxes/${sandboxId}/vnc/vnc_lite.html?autoconnect=true&reconnect=true&reconnect_delay=3000&scale=true&path=${wsPath}`;
    if (vncPassword) {
      url += `&password=${encodeURIComponent(vncPassword)}`;
    }
    return url;
  }

  get viewers(): VncViewer[] {
    return this.viewersSubject.value;
  }

  get count(): number {
    return this.viewersSubject.value.length;
  }

  get isAtCapacity(): boolean {
    return this.count >= this.MAX_SANDBOXES;
  }

  open(
    sandboxId: string,
    title?: string,
    implementationContext?: ImplementationContext,
    vncPassword?: string,
    options?: OpenVncViewerOptions
  ): string {
    const vncUrl = this.buildVncUrl(sandboxId, vncPassword);
    const config: VncConfig = { url: vncUrl, autoConnect: true, scalingMode: 'local', useIframe: true };
    const hideTray = options?.hideMinimizedTray === true;

    console.log('VncViewerService.open called:', {
      sandboxId,
      currentCount: this.count,
      maxSandboxes: this.MAX_SANDBOXES,
    });

    const existingIndex = this.viewersSubject.value.findIndex(v => v.id === sandboxId);
    if (existingIndex >= 0) {
      console.log('Viewer already exists, updating:', sandboxId);
      const viewers = [...this.viewersSubject.value];
      const prev = viewers[existingIndex];
      const merged = implementationContext ?? prev.implementationContext;
      const mergedTitle = title ?? prev.title;
      const mergedVncPassword = vncPassword ?? prev.vncPassword;
      const mergedHideTray = hideTray || prev.hideMinimizedTray === true;
      viewers[existingIndex] = {
        ...prev,
        config,
        vncPassword: mergedVncPassword,
        implementationContext: merged,
        title: mergedTitle,
        hideMinimizedTray: mergedHideTray,
        dockPosition: mergedHideTray ? ('floating' as DockPosition) : prev.dockPosition,
      };
      if (merged || mergedTitle || mergedHideTray) {
        this.setStoredContext(sandboxId, {
          implementationContext: merged,
          title: mergedTitle,
          vncPassword: mergedVncPassword,
          ...(mergedHideTray ? { hideMinimizedTray: true } : {}),
        });
      }
      this.viewersSubject.next(viewers);
      return sandboxId;
    }

    if (this.isAtCapacity) {
      const oldest = this.getOldestViewer();
      if (oldest) {
        console.log('At capacity, closing oldest viewer:', oldest.id);
        this.close(oldest.id);
      }
    }

    const newViewer: VncViewer = {
      id: sandboxId,
      config,
      dockPosition: hideTray ? 'floating' : 'minimized',
      title: title || `Sandbox ${sandboxId.slice(0, 6)}`,
      createdAt: Date.now(),
      vncPassword,
      implementationContext,
      hideMinimizedTray: hideTray,
    };

    if (implementationContext || title || hideTray) {
      this.setStoredContext(sandboxId, {
        implementationContext,
        title,
        vncPassword,
        ...(hideTray ? { hideMinimizedTray: true } : {}),
      });
    }

    console.log('Creating new viewer:', newViewer.id, 'Total will be:', this.count + 1);
    this.viewersSubject.next([...this.viewersSubject.value, newViewer]);
    return sandboxId;
  }

  /**
   * Whether persisted viewer context is the Code Ask auxiliary desktop (not the main Sandboxes dock).
   * Uses stored flag; legacy entries used title `… · Ask` only.
   */
  resolveStoredHideMinimizedTray(stored: StoredSandboxContext): boolean {
    return stored.hideMinimizedTray === true || this.isAskDesktopStoredTitle(stored.title);
  }

  /** Legacy localStorage entries may lack hideMinimizedTray; title pattern matches Code Ask desktop. */
  private isAskDesktopStoredTitle(title: string | undefined): boolean {
    return typeof title === 'string' && title.includes(' · Ask');
  }

  /**
   * Restore a viewer from stored context. Does not open Code Ask desktop — use Open desktop from Code.
   */
  restore(sandboxId: string): string | null {
    const stored = this.getStoredContext(sandboxId);
    if (!stored) return null;
    if (this.resolveStoredHideMinimizedTray(stored)) {
      return null;
    }
    return this.open(sandboxId, stored.title, stored.implementationContext, stored.vncPassword);
  }

  /**
   * Remove the viewer UI but keep localStorage context and do not delete the sandbox container.
   * Used for Code Ask auxiliary desktop (user can reopen from Ask).
   */
  dismissViewerKeepSandbox(viewerId: string): void {
    const viewer = this.viewersSubject.value.find(v => v.id === viewerId);
    if (!viewer) return;
    console.log('Dismissing viewer (sandbox keeps running):', viewerId);
    const viewers = this.viewersSubject.value.filter(v => v.id !== viewerId);
    this.viewersSubject.next(viewers);
  }

  close(viewerId: string): void {
    const viewer = this.viewersSubject.value.find(v => v.id === viewerId);
    if (viewer) {
      if (viewer.hideMinimizedTray) {
        this.dismissViewerKeepSandbox(viewerId);
        return;
      }
      console.log('Closing viewer:', viewerId);
      this.removeStoredContext(viewerId);
      const viewers = this.viewersSubject.value.filter(v => v.id !== viewerId);
      this.viewersSubject.next(viewers);
      this.viewerClosedSubject.next(viewerId);
    }
  }

  closeAll(): void {
    const viewerIds = this.viewersSubject.value.map(v => v.id);
    viewerIds.forEach(id => this.removeStoredContext(id));
    this.viewersSubject.next([]);
    viewerIds.forEach(id => this.viewerClosedSubject.next(id));
  }

  setDockPosition(viewerId: string, position: DockPosition): void {
    const target = this.viewersSubject.value.find(v => v.id === viewerId);
    let resolved = position;
    if (target?.hideMinimizedTray && position !== 'floating') {
      resolved = 'floating';
    }
    const viewers = this.viewersSubject.value.map(v =>
      v.id === viewerId ? { ...v, dockPosition: resolved } : v
    );
    this.viewersSubject.next(viewers);
  }

  minimizeAllTiled(): void {
    const out: VncViewer[] = [];
    for (const v of this.viewersSubject.value) {
      if (v.dockPosition !== 'tiled') {
        out.push(v);
        continue;
      }
      if (v.hideMinimizedTray) {
        out.push({ ...v, dockPosition: 'floating' });
        continue;
      }
      out.push({ ...v, dockPosition: 'minimized' });
    }
    this.viewersSubject.next(out);
  }

  setReadyForPr(viewerId: string, ready: boolean): void {
    const viewers = this.viewersSubject.value.map(v =>
      v.id === viewerId ? { ...v, readyForPr: ready } : v
    );
    this.viewersSubject.next(viewers);
  }

  setConnectionState(viewerId: string, state: string): void {
    const viewers = this.viewersSubject.value.map(v =>
      v.id === viewerId ? { ...v, connectionState: state } : v
    );
    this.viewersSubject.next(viewers);
  }

  setViewMode(viewerId: string, mode: 'sandbox' | 'split' | 'chat'): void {
    const viewers = this.viewersSubject.value.map(v =>
      v.id === viewerId ? { ...v, viewMode: mode } : v
    );
    this.viewersSubject.next(viewers);
  }

  setReadyForPrByStoryId(storyId: string, ready: boolean): void {
    const viewers = this.viewersSubject.value.map(v =>
      v.implementationContext?.storyId === storyId ? { ...v, readyForPr: ready } : v
    );
    this.viewersSubject.next(viewers);
  }

  getViewer(viewerId: string): VncViewer | undefined {
    return this.viewersSubject.value.find(v => v.id === viewerId);
  }

  getViewers(): VncViewer[] {
    return [...this.viewersSubject.value];
  }

  getViewerByStoryId(storyId: string): VncViewer | undefined {
    return this.viewersSubject.value.find(v => v.implementationContext?.storyId === storyId);
  }

  hasOpenSandboxForStory(storyId: string): boolean {
    return this.viewersSubject.value.some(v => v.implementationContext?.storyId === storyId);
  }

  getOpenStoryIds(): string[] {
    return this.viewersSubject.value
      .filter(v => v.implementationContext?.storyId)
      .map(v => v.implementationContext!.storyId);
  }

  private getOldestViewer(): VncViewer | undefined {
    if (this.viewersSubject.value.length === 0) return undefined;
    return this.viewersSubject.value.reduce((oldest, current) =>
      current.createdAt < oldest.createdAt ? current : oldest
    );
  }

  getStoredContext(sandboxId: string): StoredSandboxContext | null {
    try {
      const raw = localStorage.getItem(SANDBOX_CONTEXTS_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw) as Record<string, StoredSandboxContext>;
      return obj[sandboxId] ?? null;
    } catch {
      return null;
    }
  }

  private setStoredContext(sandboxId: string, ctx: StoredSandboxContext): void {
    try {
      const raw = localStorage.getItem(SANDBOX_CONTEXTS_KEY);
      const obj = (raw ? JSON.parse(raw) : {}) as Record<string, StoredSandboxContext>;
      obj[sandboxId] = ctx;
      localStorage.setItem(SANDBOX_CONTEXTS_KEY, JSON.stringify(obj));
    } catch (e) {
      console.warn('Failed to persist sandbox context', e);
    }
  }

  private removeStoredContext(sandboxId: string): void {
    try {
      const raw = localStorage.getItem(SANDBOX_CONTEXTS_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, StoredSandboxContext>;
      delete obj[sandboxId];
      localStorage.setItem(SANDBOX_CONTEXTS_KEY, JSON.stringify(obj));
    } catch {}
  }

  bringToFront(viewerId: string): void {
    const viewers = this.viewersSubject.value.map(v => {
      if (v.id === viewerId) {
        return { ...v, dockPosition: 'floating' as DockPosition };
      }
      if (v.hideMinimizedTray) {
        return { ...v, dockPosition: 'floating' as DockPosition };
      }
      return { ...v, dockPosition: 'minimized' as DockPosition };
    });
    this.viewersSubject.next(viewers);
  }
}
