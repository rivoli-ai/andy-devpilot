import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { APP_CONFIG } from './config.service';
import { ApiService } from './api.service';

describe('ApiService', () => {
  let api: ApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        ApiService,
        { provide: APP_CONFIG, useValue: { apiUrl: 'http://api.test' } },
      ],
    });
    api = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('get prepends apiUrl', () => {
    api.get('/x').subscribe();
    const r = http.expectOne('http://api.test/x');
    expect(r.request.method).toBe('GET');
    r.flush({});
  });

  it('post sends body', () => {
    api.post('/u', { a: 1 }).subscribe();
    const r = http.expectOne('http://api.test/u');
    expect(r.request.body).toEqual({ a: 1 });
    r.flush({});
  });

  it('delete hits endpoint', () => {
    api.delete('/d').subscribe((v) => expect(v).toBeNull());
    const r = http.expectOne({ url: 'http://api.test/d', method: 'DELETE' });
    expect(r.request.method).toBe('DELETE');
    r.flush(null);
  });
});
