import { InjectionToken } from '@angular/core';

export interface AppConfig {
  apiUrl: string;
}

/**
 * Injection token for the runtime app configuration loaded from /assets/config.json.
 * Provided in main.ts before bootstrapping so it is available everywhere via @Inject(APP_CONFIG).
 */
export const APP_CONFIG = new InjectionToken<AppConfig>('APP_CONFIG');

export const DEFAULT_CONFIG: AppConfig = {
  apiUrl: 'http://localhost:8080/api',
};
