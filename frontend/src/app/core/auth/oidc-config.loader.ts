import { HttpClient } from '@angular/common/http';
import { catchError, map, Observable, of } from 'rxjs';
import { LogLevel, OpenIdConfiguration } from 'angular-auth-oidc-client';
import { environment } from '../../../environments/environment';

/**
 * Response shape from GET /api/auth/config
 */
export interface AuthConfigResponse {
  providers: AuthProviderConfig[];
}

export interface AuthProviderConfig {
  name: string;
  type: 'Local' | 'BackendOAuth' | 'FrontendOidc';
  clientId?: string;
  authority?: string;
  scopes?: string;
  tenantId?: string;
  redirectUri?: string;
  authorizationUrl?: string;
}

/**
 * Fetches the auth config from the backend and maps all FrontendOidc providers
 * to OpenIdConfiguration objects for angular-auth-oidc-client.
 *
 * Used by StsConfigHttpLoader in app.config.ts so the OIDC library
 * dynamically discovers which providers are active.
 */
export function loadOidcConfigs(http: HttpClient): Observable<OpenIdConfiguration[]> {
  return http.get<AuthConfigResponse>(`${environment.apiUrl}/auth/config`).pipe(
    map((response) => {
      const oidcProviders = response.providers.filter(p => p.type === 'FrontendOidc');

      return oidcProviders.map((p): OpenIdConfiguration => ({
        configId: p.name,
        authority: p.authority ?? '',
        clientId: p.clientId ?? '',
        redirectUrl: typeof window !== 'undefined'
          ? `${window.location.origin}/auth/callback/${p.name}`
          : '',
        scope: p.scopes ?? 'openid profile email',
        responseType: 'code',
        postLogoutRedirectUri: typeof window !== 'undefined' ? window.location.origin : '',
        silentRenew: false,
        useRefreshToken: false,
        ignoreNonceAfterRefresh: true,
        triggerAuthorizationResultEvent: true,
        // Disable automatic userinfo endpoint call — the backend fetches
        // user profile via the configured ProfileEndpoint (e.g. Microsoft Graph /v1.0/me)
        // using the access token. With autoUserInfo true the library calls the IdP userinfo
        // endpoint and can fail (e.g. "Received no user data"), which then fails the whole login.
        autoUserInfo: false,
        // Skip client-side ID token validation; we validate the ID token on the backend.
        // Avoids Azure AD quirks (issuer/audience format, nonce, etc.) that can cause
        // "token(s) validation failed" in the library while the tokens are still valid.
        disableIdTokenValidation: true,
        // Debug so the library logs the exact validation failure (e.g. incorrect aud, incorrect nonce)
        // when disableIdTokenValidation is set to false for troubleshooting.
        logLevel: LogLevel.Debug,
      }));
    }),
    catchError((err) => {
      console.warn('Failed to load auth config from backend, OIDC providers will not be available:', err);
      return of([]);
    })
  );
}
