import { CanDeactivateFn } from '@angular/router';
import { BacklogComponent } from './backlog.component';

/**
 * Leaving the Backlog page while AI backlog generation is in progress requires confirmation
 * and tears down the ephemeral generation sandbox (same idea as Code → Ask / Analysis).
 */
export const backlogCanDeactivateGuard: CanDeactivateFn<BacklogComponent> = (component: BacklogComponent) => {
  if (!component?.confirmLeaveBacklogPage) {
    return true;
  }
  return component.confirmLeaveBacklogPage();
};
