import { Injectable, signal } from '@angular/core';

export interface Notification {
  id: string;
  type: 'success' | 'info' | 'warning' | 'error';
  title: string;
  message: string;
  duration?: number; // ms, 0 = persistent
  action?: {
    label: string;
    callback: () => void;
  };
}

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private notificationsSignal = signal<Notification[]>([]);
  notifications = this.notificationsSignal.asReadonly();

  // Audio context for notification sounds
  private audioContext: AudioContext | null = null;

  constructor() {
    // Initialize audio context on first user interaction
    if (typeof window !== 'undefined') {
      const initAudio = () => {
        if (!this.audioContext) {
          this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        window.removeEventListener('click', initAudio);
      };
      window.addEventListener('click', initAudio);
    }
  }

  /**
   * Show a notification
   */
  show(notification: Omit<Notification, 'id'>): string {
    const id = crypto.randomUUID();
    const newNotification: Notification = { ...notification, id };
    
    this.notificationsSignal.update(n => [...n, newNotification]);

    // Auto dismiss if duration is set
    if (notification.duration && notification.duration > 0) {
      setTimeout(() => this.dismiss(id), notification.duration);
    }

    return id;
  }

  /**
   * Show success notification
   */
  success(title: string, message: string, options?: { duration?: number; action?: Notification['action'] }): string {
    return this.show({
      type: 'success',
      title,
      message,
      duration: options?.duration ?? 5000,
      action: options?.action
    });
  }

  /**
   * Show info notification
   */
  info(title: string, message: string, options?: { duration?: number; action?: Notification['action'] }): string {
    return this.show({
      type: 'info',
      title,
      message,
      duration: options?.duration ?? 5000,
      action: options?.action
    });
  }

  /**
   * Show warning notification
   */
  warning(title: string, message: string, options?: { duration?: number; action?: Notification['action'] }): string {
    return this.show({
      type: 'warning',
      title,
      message,
      duration: options?.duration ?? 7000,
      action: options?.action
    });
  }

  /**
   * Show error notification
   */
  error(title: string, message: string, options?: { duration?: number; action?: Notification['action'] }): string {
    return this.show({
      type: 'error',
      title,
      message,
      duration: options?.duration ?? 0, // Errors persist by default
      action: options?.action
    });
  }

  /**
   * Dismiss a notification
   */
  dismiss(id: string): void {
    this.notificationsSignal.update(n => n.filter(notification => notification.id !== id));
  }

  /**
   * Dismiss all notifications
   */
  dismissAll(): void {
    this.notificationsSignal.set([]);
  }

  /**
   * Play a notification sound
   */
  playSound(type: 'success' | 'info' | 'warning' | 'error' = 'success'): void {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }

    const ctx = this.audioContext;
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    // Different sounds for different notification types
    switch (type) {
      case 'success':
        // Pleasant two-tone chime
        oscillator.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
        oscillator.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1); // E5
        oscillator.frequency.setValueAtTime(783.99, ctx.currentTime + 0.2); // G5
        gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + 0.4);
        break;
      
      case 'info':
        // Simple ding
        oscillator.frequency.setValueAtTime(880, ctx.currentTime); // A5
        gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
        gainNode.gain.setValueAtTime(0.01, ctx.currentTime + 0.15);
        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + 0.15);
        break;
      
      case 'warning':
        // Two descending tones
        oscillator.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
        oscillator.frequency.setValueAtTime(440, ctx.currentTime + 0.15); // A4
        gainNode.gain.setValueAtTime(0.25, ctx.currentTime);
        gainNode.gain.setValueAtTime(0.01, ctx.currentTime + 0.3);
        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + 0.3);
        break;
      
      case 'error':
        // Low buzz
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(220, ctx.currentTime); // A3
        gainNode.gain.setValueAtTime(0.15, ctx.currentTime);
        gainNode.gain.setValueAtTime(0.01, ctx.currentTime + 0.25);
        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + 0.25);
        break;
    }
  }

  /**
   * Show notification with sound
   */
  showWithSound(notification: Omit<Notification, 'id'>): string {
    this.playSound(notification.type);
    return this.show(notification);
  }

  /**
   * Success notification with sound
   */
  successWithSound(title: string, message: string, options?: { duration?: number; action?: Notification['action'] }): string {
    this.playSound('success');
    return this.success(title, message, options);
  }
}
