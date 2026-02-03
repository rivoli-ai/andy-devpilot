import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { VncConfig, VncConnectionState } from '../../shared/models/vnc-config.model';

/**
 * Service for managing VNC connection state
 * 
 * Note: This service is simplified to work with the iframe approach.
 * The actual VNC connection is handled by the noVNC HTML page loaded in the iframe.
 * This service primarily manages connection state for UI purposes.
 */
@Injectable({
  providedIn: 'root'
})
export class VncService {
  private connectionStateSubject = new BehaviorSubject<VncConnectionState>(VncConnectionState.Disconnected);
  private errorSubject = new BehaviorSubject<string | null>(null);

  /**
   * Observable for connection state changes
   */
  connectionState$: Observable<VncConnectionState> = this.connectionStateSubject.asObservable();

  /**
   * Observable for connection errors
   */
  error$: Observable<string | null> = this.errorSubject.asObservable();

  /**
   * Get current connection state
   */
  get connectionState(): VncConnectionState {
    return this.connectionStateSubject.value;
  }

  /**
   * Set connection state (used by iframe component)
   */
  setConnectionState(state: VncConnectionState): void {
    this.connectionStateSubject.next(state);
  }

  /**
   * Set error message
   */
  setError(error: string | null): void {
    this.errorSubject.next(error);
  }

  /**
   * Mark as connecting
   */
  connecting(): void {
    this.connectionStateSubject.next(VncConnectionState.Connecting);
    this.errorSubject.next(null);
  }

  /**
   * Mark as connected
   */
  connected(): void {
    this.connectionStateSubject.next(VncConnectionState.Connected);
    this.errorSubject.next(null);
  }

  /**
   * Mark as disconnected
   */
  disconnect(): void {
    this.connectionStateSubject.next(VncConnectionState.Disconnected);
  }

  /**
   * Mark as error
   */
  error(message: string): void {
    this.connectionStateSubject.next(VncConnectionState.Error);
    this.errorSubject.next(message);
  }

  /**
   * Toggle fullscreen for an element
   */
  toggleFullscreen(element: HTMLElement): void {
    if (!document.fullscreenElement) {
      element.requestFullscreen().catch(err => {
        console.error('Error attempting to enable fullscreen:', err);
      });
    } else {
      document.exitFullscreen();
    }
  }

  /**
   * Take a screenshot from a canvas element
   */
  takeScreenshot(canvas: HTMLCanvasElement): void {
    try {
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `vnc-screenshot-${Date.now()}.png`;
          a.click();
          URL.revokeObjectURL(url);
        }
      }, 'image/png');
    } catch (error) {
      console.error('Error taking screenshot:', error);
    }
  }

  /**
   * Build iframe URL from VNC config
   * Simple format: just use the URL as-is if it's already correct,
   * or ensure it points to vnc.html with autoconnect
   */
  buildIframeUrl(config: VncConfig): string {
    let url = config.url.trim();
    
    console.log('buildIframeUrl input:', url);
    
    // If URL already contains vnc.html, just ensure autoconnect is set
    if (url.includes('vnc.html')) {
      // Add autoconnect if not present
      if (!url.includes('autoconnect')) {
        url += (url.includes('?') ? '&' : '?') + 'autoconnect=true';
      }
      console.log('buildIframeUrl output:', url);
      return url;
    }
    
    // Extract host and port from the URL
    let host = '';
    let port = '6080';
    
    // Handle different URL formats
    if (url.startsWith('ws://') || url.startsWith('wss://')) {
      url = url.replace(/^wss?:\/\//, '');
      const parts = url.split('/')[0].split(':');
      host = parts[0];
      port = parts[1] || '6080';
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      try {
        const urlObj = new URL(url);
        host = urlObj.hostname;
        port = urlObj.port || '6080';
      } catch {
        url = url.replace(/^https?:\/\//, '');
        const parts = url.split('/')[0].split(':');
        host = parts[0];
        port = parts[1] || '6080';
      }
    } else {
      const parts = url.split('/')[0].split(':');
      host = parts[0];
      port = parts[1] || '6080';
    }
    
    // Build simple URL - noVNC will connect to websocket on same host:port automatically
    const finalUrl = `http://${host}:${port}/vnc.html?autoconnect=true&resize=scale`;
    console.log('buildIframeUrl output:', finalUrl);
    
    return finalUrl;
  }
}
