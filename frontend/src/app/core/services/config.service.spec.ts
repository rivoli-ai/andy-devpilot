import { APP_CONFIG, DEFAULT_CONFIG } from './config.service';

describe('config.service', () => {
  it('DEFAULT_CONFIG uses local API base', () => {
    expect(DEFAULT_CONFIG.apiUrl).toBe('http://localhost:8080/api');
  });

  it('APP_CONFIG is an injection token', () => {
    expect(APP_CONFIG.toString()).toContain('InjectionToken');
  });
});
