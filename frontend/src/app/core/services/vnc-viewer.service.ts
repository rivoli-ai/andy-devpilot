import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { VncConfig } from '../../shared/models/vnc-config.model';

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
  bridgeUrl?: string;
  sandboxToken?: string;
  vncPassword?: string;
  implementationContext?: ImplementationContext;
  readyForPr?: boolean;
  connectionState?: string;
  viewMode?: 'sandbox' | 'split' | 'chat';
}

/**
 * Service for managing multiple VNC viewer instances
 * Limited to MAX_SANDBOXES concurrent viewers
 */
const SANDBOX_CONTEXTS_KEY = 'devpilot_sandbox_contexts';

export interface StoredSandboxContext {
  implementationContext?: ImplementationContext;
  title?: string;
  bridgeUrl?: string;
  sandboxToken?: string;
  vncUrl?: string;
  vncPassword?: string;
}

@Injectable({
  providedIn: 'root'
})
export class VncViewerService {
  private readonly MAX_SANDBOXES = 5;
  
  private viewersSubject = new BehaviorSubject<VncViewer[]>([]);
  private viewerClosedSubject = new Subject<string>(); // Emits sandbox ID when closed
  
  /**
   * Observable for all open viewers
   */
  viewers$: Observable<VncViewer[]> = this.viewersSubject.asObservable();
  
  /**
   * Observable that emits when a viewer is closed (for sandbox cleanup)
   */
  viewerClosed$: Observable<string> = this.viewerClosedSubject.asObservable();

  /**
   * Get all open viewers
   */
  get viewers(): VncViewer[] {
    return this.viewersSubject.value;
  }

  /**
   * Get current count
   */
  get count(): number {
    return this.viewersSubject.value.length;
  }

  /**
   * Check if at capacity
   */
  get isAtCapacity(): boolean {
    return this.count >= this.MAX_SANDBOXES;
  }

  open(config: VncConfig, id?: string, title?: string, implementationContext?: ImplementationContext, sandboxToken?: string, bridgeUrl?: string, vncPassword?: string): string {
    const viewerId = id || `sandbox-${Date.now()}`;

    console.log('VncViewerService.open called:', {
      viewerId,
      currentCount: this.count,
      maxSandboxes: this.MAX_SANDBOXES,
      bridgeUrl,
      hasSandboxToken: !!sandboxToken
    });

    const existingIndex = this.viewersSubject.value.findIndex(v => v.id === viewerId);
    if (existingIndex >= 0) {
      console.log('Viewer already exists, updating:', viewerId);
      const viewers = [...this.viewersSubject.value];
      const merged = implementationContext ?? viewers[existingIndex].implementationContext;
      const mergedTitle = title ?? viewers[existingIndex].title;
      const mergedToken = sandboxToken ?? viewers[existingIndex].sandboxToken;
      const mergedBridgeUrl = bridgeUrl ?? viewers[existingIndex].bridgeUrl;
      const mergedVncPassword = vncPassword ?? viewers[existingIndex].vncPassword;
      const mergedVncUrl = config.url || viewers[existingIndex].config.url;
      viewers[existingIndex] = {
        ...viewers[existingIndex],
        config,
        sandboxToken: mergedToken,
        bridgeUrl: mergedBridgeUrl,
        vncPassword: mergedVncPassword,
        implementationContext: merged,
        title: mergedTitle
      };
      if (merged || mergedTitle || mergedBridgeUrl) {
        this.setStoredContext(viewerId, { implementationContext: merged, title: mergedTitle, sandboxToken: mergedToken, bridgeUrl: mergedBridgeUrl, vncUrl: mergedVncUrl, vncPassword: mergedVncPassword });
      }
      this.viewersSubject.next(viewers);
      return viewerId;
    }

    if (this.isAtCapacity) {
      const oldest = this.getOldestViewer();
      if (oldest) {
        console.log('At capacity, closing oldest viewer:', oldest.id);
        this.close(oldest.id);
      }
    }

    const newViewer: VncViewer = {
      id: viewerId,
      config,
      dockPosition: 'minimized',
      title: title || `Sandbox ${viewerId.slice(0, 6)}`,
      createdAt: Date.now(),
      sandboxToken,
      bridgeUrl,
      vncPassword,
      implementationContext
    };

    if (implementationContext || title || bridgeUrl) {
      this.setStoredContext(viewerId, { implementationContext, title, sandboxToken, bridgeUrl, vncUrl: config.url, vncPassword });
    }

    console.log('Creating new viewer:', newViewer.id, 'Total will be:', this.count + 1);
    this.viewersSubject.next([...this.viewersSubject.value, newViewer]);
    return viewerId;
  }

  /**
   * Close a specific viewer and emit event for sandbox cleanup
   */
  close(viewerId: string): void {
    const viewer = this.viewersSubject.value.find(v => v.id === viewerId);
    if (viewer) {
      console.log('Closing viewer:', viewerId);
      this.removeStoredContext(viewerId);
      const viewers = this.viewersSubject.value.filter(v => v.id !== viewerId);
      this.viewersSubject.next(viewers);
      // Emit for sandbox cleanup
      this.viewerClosedSubject.next(viewerId);
    }
  }

  /**
   * Close all viewers and emit events for sandbox cleanup
   */
  closeAll(): void {
    const viewerIds = this.viewersSubject.value.map(v => v.id);
    viewerIds.forEach(id => this.removeStoredContext(id));
    this.viewersSubject.next([]);
    // Emit for each sandbox cleanup
    viewerIds.forEach(id => this.viewerClosedSubject.next(id));
  }

  /**
   * Update dock position for a viewer
   */
  setDockPosition(viewerId: string, position: DockPosition): void {
    const viewers = this.viewersSubject.value.map(v => 
      v.id === viewerId ? { ...v, dockPosition: position } : v
    );
    this.viewersSubject.next(viewers);
  }

  /** All dock-tile viewers back to minimized chips (one emission). */
  minimizeAllTiled(): void {
    const viewers = this.viewersSubject.value.map(v =>
      v.dockPosition === 'tiled' ? { ...v, dockPosition: 'minimized' as const } : v
    );
    this.viewersSubject.next(viewers);
  }

  /**
   * Set "ready for PR" state for a viewer (shows alert on minimized widget)
   */
  setReadyForPr(viewerId: string, ready: boolean): void {
    const viewers = this.viewersSubject.value.map(v => 
      v.id === viewerId ? { ...v, readyForPr: ready } : v
    );
    this.viewersSubject.next(viewers);
  }

  /**
   * Set connection state for a viewer (persists when viewer moves floating↔minimized)
   */
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

  /**
   * Set "ready for PR" state for a viewer by story ID
   */
  setReadyForPrByStoryId(storyId: string, ready: boolean): void {
    const viewers = this.viewersSubject.value.map(v => 
      v.implementationContext?.storyId === storyId ? { ...v, readyForPr: ready } : v
    );
    this.viewersSubject.next(viewers);
  }

  /**
   * Get a specific viewer
   */
  getViewer(viewerId: string): VncViewer | undefined {
    return this.viewersSubject.value.find(v => v.id === viewerId);
  }

  /**
   * Get all viewers (snapshot)
   */
  getViewers(): VncViewer[] {
    return [...this.viewersSubject.value];
  }

  /**
   * Check if a sandbox is open for a specific story
   */
  getViewerByStoryId(storyId: string): VncViewer | undefined {
    return this.viewersSubject.value.find(v => v.implementationContext?.storyId === storyId);
  }

  /**
   * Check if any sandbox is open for a story
   */
  hasOpenSandboxForStory(storyId: string): boolean {
    return this.viewersSubject.value.some(v => v.implementationContext?.storyId === storyId);
  }

  /**
   * Get all story IDs that have open sandboxes
   */
  getOpenStoryIds(): string[] {
    return this.viewersSubject.value
      .filter(v => v.implementationContext?.storyId)
      .map(v => v.implementationContext!.storyId);
  }

  /**
   * Get the oldest viewer (for auto-closing when at capacity)
   */
  private getOldestViewer(): VncViewer | undefined {
    if (this.viewersSubject.value.length === 0) return undefined;
    return this.viewersSubject.value.reduce((oldest, current) => 
      current.createdAt < oldest.createdAt ? current : oldest
    );
  }

  /**
   * Get stored context for a sandbox (for restore after page refresh)
   */
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

  /**
   * Bring a viewer to front (set to floating, minimize others)
   */
  bringToFront(viewerId: string): void {
    const viewers = this.viewersSubject.value.map(v => ({
      ...v,
      dockPosition: v.id === viewerId ? 'floating' as DockPosition : 'minimized' as DockPosition
    }));
    this.viewersSubject.next(viewers);
  }
}
