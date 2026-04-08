import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { APP_CONFIG } from './config.service';
import { SandboxService } from './sandbox.service';

describe('SandboxService', () => {
  let svc: SandboxService;
  let http: HttpTestingController;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        SandboxService,
        { provide: APP_CONFIG, useValue: { apiUrl: 'http://api.test' } },
      ],
    });
    svc = TestBed.inject(SandboxService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    jest.restoreAllMocks();
  });

  it('createSandbox posts to sandboxes URL with default resolution', () => {
    svc.createSandbox({ repo_url: 'https://git/repo' }).subscribe((res) => {
      expect(res.id).toBe('sb-1');
    });

    const req = http.expectOne('http://api.test/sandboxes');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toMatchObject({
      resolution: '1920x1080x24',
      repo_url: 'https://git/repo',
    });
    req.flush({
      id: 'sb-1',
      port: 5901,
      url: 'http://vnc',
      status: 'running',
    });
  });

  it('listSandboxes maps sandboxes array', () => {
    svc.listSandboxes().subscribe((list) => {
      expect(list.length).toBe(1);
      expect(list[0].id).toBe('a');
    });

    const req = http.expectOne('http://api.test/sandboxes');
    req.flush({ sandboxes: [{ id: 'a', port: 1, status: 'up' }] });
  });

  it('listSandboxes returns empty on error', () => {
    svc.listSandboxes().subscribe((list) => expect(list).toEqual([]));

    const req = http.expectOne('http://api.test/sandboxes');
    req.flush('err', { status: 500, statusText: 'Err' });
  });

  it('getSandbox GETs by id', () => {
    svc.getSandbox('x').subscribe((s) => expect(s?.status).toBe('ok'));

    const req = http.expectOne('http://api.test/sandboxes/x');
    expect(req.request.method).toBe('GET');
    req.flush({ id: 'x', port: 2, status: 'ok' });
  });

  it('deleteSandbox clears current when id matches', () => {
    svc.createSandbox({}).subscribe();
    http.expectOne('http://api.test/sandboxes').flush({
      id: 'cur',
      port: 1,
      url: 'u',
      status: 's',
    });
    expect(svc.currentSandbox?.id).toBe('cur');

    svc.deleteSandbox('cur').subscribe((ok) => expect(ok).toBe(true));
    const del = http.expectOne('http://api.test/sandboxes/cur');
    expect(del.request.method).toBe('DELETE');
    del.flush({ status: 'gone' });
    expect(svc.currentSandbox).toBeNull();
  });

  it('clearCurrentSandbox resets subject', () => {
    svc.clearCurrentSandbox();
    expect(svc.currentSandbox).toBeNull();
  });

  it('checkHealth returns true on successful GET', () => {
    svc.checkHealth().subscribe((ok) => expect(ok).toBe(true));
    const req = http.expectOne('http://api.test/sandboxes');
    req.flush({ status: 'ok' });
  });

  it('checkHealth returns false on error', () => {
    svc.checkHealth().subscribe((ok) => expect(ok).toBe(false));
    const req = http.expectOne('http://api.test/sandboxes');
    req.error(new ProgressEvent('error'));
  });
});
