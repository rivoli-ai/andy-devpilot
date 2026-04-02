import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { APP_CONFIG, AppConfig, DEFAULT_CONFIG } from './app/core/services/config.service';

// noVNC (iframe) + dock layout use ResizeObserver; Chrome may log a benign loop warning.
// It does not indicate a broken UI. Suppress so real errors stay visible.
const resizeObserverBenignRe =
  /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i;
window.addEventListener(
  'error',
  (event: ErrorEvent) => {
    if (typeof event.message === 'string' && resizeObserverBenignRe.test(event.message)) {
      event.stopImmediatePropagation();
    }
  },
  true
);

fetch('/assets/config.json')
  .then((res) => res.json())
  .catch(() => DEFAULT_CONFIG)
  .then((config: AppConfig) => {
    bootstrapApplication(AppComponent, {
      ...appConfig,
      providers: [
        ...appConfig.providers,
        { provide: APP_CONFIG, useValue: config },
      ],
    });
  })
  .catch((err) => console.error(err));
