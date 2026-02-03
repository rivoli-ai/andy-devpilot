import { Component, Input, Output, EventEmitter, signal, computed, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VncViewer, VncViewerService } from '../../core/services/vnc-viewer.service';
import { VncViewerComponent } from '../vnc-viewer/vnc-viewer.component';

/**
 * Dock Panel Component
 * Manages multiple VNC viewers docked to the same position with tabs
 */
@Component({
  selector: 'app-dock-panel',
  standalone: true,
  imports: [CommonModule, VncViewerComponent],
  template: `
    <div class="dock-panel" 
         [class.dock-right]="position === 'right'"
         [class.dock-bottom]="position === 'bottom'">
      
      <!-- Tab Bar -->
      <div class="dock-tabs">
        <div class="tabs-list">
          @for (viewer of viewers; track viewer.id) {
            <button 
              class="dock-tab"
              [class.active]="activeViewerId() === viewer.id"
              (click)="setActiveViewer(viewer.id)">
              <span class="tab-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                  <line x1="8" y1="21" x2="16" y2="21"/>
                  <line x1="12" y1="17" x2="12" y2="21"/>
                </svg>
              </span>
              <span class="tab-title">{{ viewer.title || 'Sandbox' }}</span>
              <button class="tab-close" (click)="closeViewer(viewer.id); $event.stopPropagation()" title="Close">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </button>
          }
        </div>
        
        <div class="tabs-actions">
          <button class="action-btn" (click)="undockActive()" title="Float">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="9" y1="3" x2="9" y2="21"/>
            </svg>
          </button>
          <button class="action-btn" (click)="minimizeActive()" title="Minimize">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
      </div>
      
      <!-- Active Viewer Content -->
      <div class="dock-content">
        @if (activeViewer(); as viewer) {
          <app-vnc-viewer
            [config]="viewer.config"
            [viewerId]="viewer.id"
            [viewerIndex]="0"
            [initialDockPosition]="'floating'"
            [viewerTitle]="viewer.title || 'Sandbox'"
            [bridgePort]="viewer.bridgePort"
            [implementationContext]="viewer.implementationContext"
            [embedded]="true"
            (closeEvent)="closeViewer(viewer.id)">
          </app-vnc-viewer>
        }
      </div>
    </div>
  `,
  styles: [`
    .dock-panel {
      display: flex;
      flex-direction: column;
      background: var(--surface-elevated, #1a1a2e);
      border: 1px solid var(--border-light, rgba(255, 255, 255, 0.1));
      overflow: hidden;
    }
    
    .dock-panel.dock-right {
      position: fixed;
      top: 0;
      right: 0;
      width: 45%;
      height: 100vh;
      border-left: 1px solid var(--border-light);
      border-radius: 0;
      z-index: 1000;
    }
    
    .dock-panel.dock-bottom {
      position: fixed;
      bottom: 0;
      left: var(--sidebar-width, 260px);
      right: 0;
      height: 45vh;
      border-top: 1px solid var(--border-light);
      border-radius: 0;
      z-index: 1000;
    }
    
    /* Tab Bar */
    .dock-tabs {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--surface-ground, #0f0f1a);
      border-bottom: 1px solid var(--border-light);
      gap: 8px;
    }
    
    .tabs-list {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 1;
      overflow-x: auto;
      scrollbar-width: none;
    }
    
    .tabs-list::-webkit-scrollbar {
      display: none;
    }
    
    .dock-tab {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 8px;
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
    }
    
    .dock-tab:hover {
      background: var(--surface-hover, rgba(255, 255, 255, 0.05));
      color: var(--text-primary);
    }
    
    .dock-tab.active {
      background: var(--surface-elevated, #1e1e2e);
      border-color: var(--border-light);
      color: var(--text-primary);
    }
    
    .tab-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--primary, #6366f1);
    }
    
    .tab-title {
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .tab-close {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--text-tertiary);
      cursor: pointer;
      opacity: 0;
      transition: all 0.2s ease;
    }
    
    .dock-tab:hover .tab-close {
      opacity: 1;
    }
    
    .tab-close:hover {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }
    
    /* Tab Actions */
    .tabs-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      padding-left: 8px;
      border-left: 1px solid var(--border-light);
    }
    
    .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s ease;
    }
    
    .action-btn:hover {
      background: var(--surface-hover, rgba(255, 255, 255, 0.1));
      color: var(--text-primary);
    }
    
    /* Content Area */
    .dock-content {
      flex: 1;
      overflow: hidden;
      position: relative;
    }
    
    .dock-content ::ng-deep app-vnc-viewer {
      position: absolute;
      inset: 0;
    }
    
    .dock-content ::ng-deep .vnc-popup {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      border-radius: 0 !important;
      box-shadow: none !important;
    }
    
    .dock-content ::ng-deep .vnc-backdrop {
      display: none !important;
    }
    
    .dock-content ::ng-deep .popup-header {
      display: none !important;
    }
    
    .dock-content ::ng-deep .popup-content {
      height: 100% !important;
    }
    
    /* Light mode */
    :host-context([data-theme="light"]) .dock-panel {
      background: var(--surface-card, #ffffff);
      border-color: var(--border-color, #e5e7eb);
    }
    
    :host-context([data-theme="light"]) .dock-tabs {
      background: var(--surface-ground, #f3f4f6);
    }
    
    :host-context([data-theme="light"]) .dock-tab.active {
      background: var(--surface-card, #ffffff);
    }
    
    /* Responsive */
    @media (max-width: 768px) {
      .dock-panel.dock-right,
      .dock-panel.dock-bottom {
        width: 100%;
        height: 50vh;
        left: 0;
      }
    }
  `]
})
export class DockPanelComponent implements OnChanges {
  @Input() viewers: VncViewer[] = [];
  @Input() position: 'right' | 'bottom' = 'right';
  @Output() viewerClosed = new EventEmitter<string>();
  @Output() viewerUndocked = new EventEmitter<string>();
  @Output() viewerMinimized = new EventEmitter<string>();

  activeViewerId = signal<string>('');

  constructor(private vncViewerService: VncViewerService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['viewers']) {
      // Set first viewer as active if none selected
      if (this.viewers.length > 0 && !this.activeViewerId()) {
        this.activeViewerId.set(this.viewers[0].id);
      }
      // If active viewer was removed, select first available
      if (this.activeViewerId() && !this.viewers.find(v => v.id === this.activeViewerId())) {
        this.activeViewerId.set(this.viewers[0]?.id || '');
      }
    }
  }

  activeViewer = computed(() => {
    return this.viewers.find(v => v.id === this.activeViewerId()) || this.viewers[0];
  });

  setActiveViewer(viewerId: string): void {
    this.activeViewerId.set(viewerId);
  }

  closeViewer(viewerId: string): void {
    this.viewerClosed.emit(viewerId);
  }

  undockActive(): void {
    const activeId = this.activeViewerId();
    if (activeId) {
      this.viewerUndocked.emit(activeId);
    }
  }

  minimizeActive(): void {
    const activeId = this.activeViewerId();
    if (activeId) {
      this.viewerMinimized.emit(activeId);
    }
  }
}
