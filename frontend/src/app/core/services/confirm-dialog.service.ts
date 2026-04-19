import { Injectable, signal } from '@angular/core';

export type ConfirmDialogVariant = 'default' | 'danger';

export interface ConfirmDialogOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: ConfirmDialogVariant;
}

export interface AlertDialogOptions {
  title?: string;
  message: string;
  okText?: string;
}

type ConfirmOpen = ConfirmDialogOptions & {
  kind: 'confirm';
  resolve: (value: boolean) => void;
};

type AlertOpen = AlertDialogOptions & {
  kind: 'alert';
  resolve: () => void;
};

export type ConfirmDialogOpenState = ConfirmOpen | AlertOpen;

/**
 * Global confirm / alert UI (replaces window.confirm / window.alert).
 * Renders via {@link ConfirmDialogComponent} in the app shell.
 */
@Injectable({
  providedIn: 'root'
})
export class ConfirmDialogService {
  private readonly state = signal<ConfirmDialogOpenState | null>(null);

  /** Bound by {@link ConfirmDialogComponent}. */
  readonly openState = this.state.asReadonly();

  confirm(options: ConfirmDialogOptions): Promise<boolean> {
    return new Promise(resolve => {
      this.dismissPending();
      this.state.set({
        kind: 'confirm',
        title: options.title ?? 'Confirm',
        message: options.message,
        confirmText: options.confirmText ?? 'OK',
        cancelText: options.cancelText ?? 'Cancel',
        variant: options.variant ?? 'default',
        resolve
      });
    });
  }

  alert(options: AlertDialogOptions): Promise<void> {
    return new Promise(resolve => {
      this.dismissPending();
      this.state.set({
        kind: 'alert',
        title: options.title ?? 'Notice',
        message: options.message,
        okText: options.okText ?? 'OK',
        resolve
      });
    });
  }

  /** User chose confirm (confirm dialog only). */
  confirmOk(): void {
    const s = this.state();
    if (s?.kind === 'confirm') {
      s.resolve(true);
      this.state.set(null);
    }
  }

  /** User chose cancel or closed (confirm dialog only). */
  confirmCancel(): void {
    const s = this.state();
    if (s?.kind === 'confirm') {
      s.resolve(false);
      this.state.set(null);
    }
  }

  /** User dismissed alert. */
  alertOk(): void {
    const s = this.state();
    if (s?.kind === 'alert') {
      s.resolve();
      this.state.set(null);
    }
  }

  private dismissPending(): void {
    const s = this.state();
    if (!s) return;
    if (s.kind === 'confirm') {
      s.resolve(false);
    } else {
      s.resolve();
    }
    this.state.set(null);
  }
}
