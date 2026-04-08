import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService, AuthResponse } from './auth.service';
import type { AuthConfigResponse } from '../auth/oidc-config.loader';

function jwtWithPayload(payload: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(payload));
  return `h.${body}.s`;
}

describe('AuthService', () => {
  let api: { get: jest.Mock; post: jest.Mock; delete: jest.Mock; patch: jest.Mock };

  beforeEach(() => {
    localStorage.clear();
    api = {
      get: jest.fn(),
      post: jest.fn(),
      delete: jest.fn(),
      patch: jest.fn(),
    };
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: ApiService, useValue: api },
      ],
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('loads token and admin flag from localStorage on init', () => {
    const token = jwtWithPayload({ role: 'admin' });
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify({ id: '1', email: 'a@b.c' }));

    const svc = TestBed.inject(AuthService);
    expect(svc.getToken()).toBe(token);
    expect(svc.getCurrentUser()?.email).toBe('a@b.c');
    expect(svc.isAdmin()).toBe(true);
    expect(svc.isLoggedIn()).toBe(true);
  });

  it('detects admin from roles array in JWT', () => {
    const token = jwtWithPayload({ roles: ['user', 'admin'] });
    localStorage.setItem('auth_token', token);

    const svc = TestBed.inject(AuthService);
    expect(svc.isAdmin()).toBe(true);
  });

  it('detects admin from Microsoft role claim', () => {
    const token = jwtWithPayload({
      'http://schemas.microsoft.com/ws/2008/06/identity/claims/role': 'admin',
    });
    localStorage.setItem('auth_token', token);

    const svc = TestBed.inject(AuthService);
    expect(svc.isAdmin()).toBe(true);
  });

  it('isAdmin is false for invalid JWT', () => {
    localStorage.setItem('auth_token', 'not-a-jwt');

    const svc = TestBed.inject(AuthService);
    expect(svc.isAdmin()).toBe(false);
  });

  it('loadProviderConfig fetches once and caches', async () => {
    const response: AuthConfigResponse = {
      providers: [{ name: 'Github', type: 'BackendOAuth' }],
    };
    api.get.mockReturnValue(of(response));

    const svc = TestBed.inject(AuthService);
    const first = await svc.loadProviderConfig();
    const second = await svc.loadProviderConfig();

    expect(first).toEqual(response.providers);
    expect(second).toEqual(response.providers);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/auth/config');
  });

  it('loadProviderConfig returns empty array on error', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      api.get.mockReturnValue(throwError(() => new Error('network')));

      const svc = TestBed.inject(AuthService);
      const result = await svc.loadProviderConfig();

      expect(result).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('getProviderConfig resolves by name case-insensitively', async () => {
    api.get.mockReturnValue(
      of({
        providers: [
          { name: 'GitHub', type: 'BackendOAuth' as const },
          { name: 'Local', type: 'Local' as const },
        ],
      })
    );

    const svc = TestBed.inject(AuthService);
    await svc.loadProviderConfig();
    expect(svc.getProviderConfig('github')?.name).toBe('GitHub');
    expect(svc.getProviderConfig('LOCAL')?.type).toBe('Local');
  });

  it('logout clears signals and localStorage', () => {
    const token = jwtWithPayload({ role: 'user' });
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify({ id: '1', email: 'x@y.z' }));

    const svc = TestBed.inject(AuthService);
    expect(svc.isLoggedIn()).toBe(true);

    svc.logout();

    expect(svc.getToken()).toBeNull();
    expect(svc.getCurrentUser()).toBeNull();
    expect(svc.isLoggedIn()).toBe(false);
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('auth_user')).toBeNull();
  });

  it('login posts credentials and sets auth state', async () => {
    const response: AuthResponse = {
      token: jwtWithPayload({ role: 'admin' }),
      user: { id: 'u1', email: 'me@test.dev' },
    };
    api.post.mockReturnValue(of(response));

    const svc = TestBed.inject(AuthService);
    const out = await svc.login('me@test.dev', 'secret');

    expect(out).toEqual(response);
    expect(svc.getToken()).toBe(response.token);
    expect(svc.getCurrentUser()?.id).toBe('u1');
    expect(svc.isAdmin()).toBe(true);
    expect(localStorage.getItem('auth_token')).toBe(response.token);
  });

  it('computed filters split providers by type', async () => {
    api.get.mockReturnValue(
      of({
        providers: [
          { name: 'L', type: 'Local' as const },
          { name: 'G', type: 'BackendOAuth' as const },
          { name: 'A', type: 'FrontendOidc' as const },
        ],
      })
    );

    const svc = TestBed.inject(AuthService);
    await svc.loadProviderConfig();

    expect(svc.localProviders().length).toBe(1);
    expect(svc.backendOAuthProviders().length).toBe(1);
    expect(svc.frontendOidcProviders().length).toBe(1);
    expect(svc.isLocalEnabled()).toBe(true);
  });
});
