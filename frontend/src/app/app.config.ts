import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { HttpClient, provideHttpClient, withInterceptorsFromDi, withInterceptors } from '@angular/common/http';
import { provideAuth, StsConfigHttpLoader, StsConfigLoader } from 'angular-auth-oidc-client';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { loadOidcConfigs } from './core/auth/oidc-config.loader';
import { APP_CONFIG, AppConfig } from './core/services/config.service';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideHttpClient(
      withInterceptorsFromDi(),
      withInterceptors([authInterceptor])
    ),
    provideAuth({
      loader: {
        provide: StsConfigLoader,
        useFactory: (http: HttpClient, config: AppConfig) =>
          new StsConfigHttpLoader(loadOidcConfigs(http, config.apiUrl)),
        deps: [HttpClient, APP_CONFIG],
      },
    }),
  ]
};
