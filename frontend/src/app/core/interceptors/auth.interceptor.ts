import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

/**
 * Paths where 401 is an expected auth handshake / credential failure — do not force logout + redirect.
 */
function shouldSkip401Redirect(requestUrl: string): boolean {
  let path: string;
  try {
    path = new URL(
      requestUrl,
      typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
    ).pathname.toLowerCase();
  } catch {
    path = requestUrl.toLowerCase();
  }

  if (path.includes('/auth/login') || path.includes('/auth/register')) {
    return true;
  }
  if (path.includes('/auth/') && (path.includes('/callback') || path.includes('/authorize'))) {
    return true;
  }
  if (path.includes('/auth/') && path.includes('/token')) {
    return true;
  }
  return false;
}

/**
 * HTTP interceptor to add JWT token to authenticated requests and redirect to login on session expiry (401).
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const token = authService.getToken();

  let outgoing = req;
  // Don't override Authorization header if it's already set (e.g. sandbox bridge token)
  if (token && !req.headers.has('Authorization')) {
    outgoing = req.clone({
      setHeaders: {
        Authorization: `Bearer ${token}`
      }
    });
  }

  return next(outgoing).pipe(
    catchError((err: unknown) => {
      const httpErr = err as HttpErrorResponse;
      if (httpErr?.status === 401 && !shouldSkip401Redirect(req.url)) {
        authService.logout();
        try {
          sessionStorage.setItem('devpilot_session_expired', '1');
        } catch {
          /* ignore quota / private mode */
        }
        if (!router.url.startsWith('/login')) {
          void router.navigate(['/login']);
        }
      }
      return throwError(() => err);
    })
  );
};
