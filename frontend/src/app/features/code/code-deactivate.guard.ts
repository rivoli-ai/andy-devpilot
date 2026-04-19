import { CanDeactivateFn } from '@angular/router';
import { CodeComponent } from './code.component';

/**
 * Leaving the Code page while an Ask sandbox is active requires confirmation and stops the container.
 */
export const codeCanDeactivateGuard: CanDeactivateFn<CodeComponent> = (component: CodeComponent) => {
  if (!component?.confirmLeaveCodePage) {
    return true;
  }
  return component.confirmLeaveCodePage();
};
