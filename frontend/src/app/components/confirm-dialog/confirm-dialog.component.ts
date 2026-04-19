import { Component, HostListener, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.css'
})
export class ConfirmDialogComponent {
  readonly dialog = inject(ConfirmDialogService);

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') {
      return;
    }
    const state = this.dialog.openState();
    if (!state) {
      return;
    }
    ev.preventDefault();
    if (state.kind === 'confirm') {
      this.dialog.confirmCancel();
    } else {
      this.dialog.alertOk();
    }
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('confirm-dialog-backdrop')) {
      if (this.dialog.openState()?.kind === 'confirm') {
        this.dialog.confirmCancel();
      } else {
        this.dialog.alertOk();
      }
    }
  }
}
