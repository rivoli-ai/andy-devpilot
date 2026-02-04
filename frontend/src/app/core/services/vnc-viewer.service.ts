import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { VncConfig } from '../../shared/models/vnc-config.model';

export type DockPosition = 'floating' | 'right' | 'bottom' | 'minimized';

/** Context when sandbox was opened for implementing a user story */
export interface ImplementationContext {
  repositoryId: string;
  repositoryFullName: string;
  defaultBranch: string;
  storyTitle: string;
  storyId: string;
}

export interface VncViewer {
  id: string;
  config: VncConfig;
  dockPosition: DockPosition;
  title?: string;
  createdAt: number; // Timestamp for tracking oldest
  bridgePort?: number; // Port for Bridge API communication
  /** Set when opened from backlog for user story implementation - enables Push & Create PR */
  implementationContext?: ImplementationContext;
  /** True when implementation is complete and waiting for PR */
  readyForPr?: boolean;
}

/**
 * Service for managing multiple VNC viewer instances
 * Limited to MAX_SANDBOXES concurrent viewers
 */
const SANDBOX_CONTEXTS_KEY = 'devpilot_sandbox_contexts';

/** Stored per sandbox for restore after page refresh (chat/LLM panel needs bridgePort) */
export interface StoredSandboxContext {
  implementationContext?: ImplementationContext;
  title?: string;
  bridgePort?: number;
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

  /**
   * Open a new VNC viewer (opens as minimized by default if other viewers exist)
   * Auto-closes oldest viewer if at max capacity
   * @param config VNC connection config
   * @param id Optional viewer ID (sandbox ID)
   * @param title Optional title for the viewer
   * @param bridgePort Optional Bridge API port for sandbox communication
   * @param implementationContext Optional context when opened for user story implementation (enables Push & Create PR)
   */
  open(config: VncConfig, id?: string, title?: string, bridgePort?: number, implementationContext?: ImplementationContext): string {
    const viewerId = id || `sandbox-${Date.now()}`;
    const hasExistingViewers = this.viewersSubject.value.length > 0;
    
    console.log('VncViewerService.open called:', { 
      viewerId, 
      currentCount: this.count,
      maxSandboxes: this.MAX_SANDBOXES,
      bridgePort
    });
    
    // Check if viewer with same ID exists
    const existingIndex = this.viewersSubject.value.findIndex(v => v.id === viewerId);
    if (existingIndex >= 0) {
      console.log('Viewer already exists, updating:', viewerId);
      const viewers = [...this.viewersSubject.value];
      const merged = implementationContext ?? viewers[existingIndex].implementationContext;
      const mergedTitle = title ?? viewers[existingIndex].title;
      const mergedPort = bridgePort ?? viewers[existingIndex].bridgePort;
      viewers[existingIndex] = {
        ...viewers[existingIndex],
        config,
        dockPosition: 'floating',
        bridgePort: mergedPort,
        implementationContext: merged,
        title: mergedTitle
      };
      if (merged || mergedTitle || mergedPort !== undefined) {
        this.setStoredContext(viewerId, { implementationContext: merged, title: mergedTitle, bridgePort: mergedPort });
      }
      this.viewersSubject.next(viewers);
      return viewerId;
    }
    
    // If at capacity, close the oldest viewer
    if (this.isAtCapacity) {
      const oldest = this.getOldestViewer();
      if (oldest) {
        console.log('At capacity, closing oldest viewer:', oldest.id);
        this.close(oldest.id);
      }
    }
    
    // Create new viewer - always start minimized
    const newViewer: VncViewer = {
      id: viewerId,
      config,
      dockPosition: 'minimized', // Always start minimized
      title: title || `Sandbox ${viewerId.slice(0, 6)}`,
      createdAt: Date.now(),
      bridgePort,
      implementationContext
    };

    if (implementationContext || title || bridgePort !== undefined) {
      this.setStoredContext(viewerId, { implementationContext, title, bridgePort });
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
