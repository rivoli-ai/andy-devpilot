import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  let svc: NotificationService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(NotificationService);
  });

  it('show adds notification with id', () => {
    const id = svc.show({ type: 'info', title: 'T', message: 'M' });
    expect(id.length).toBeGreaterThan(0);
    expect(svc.notifications().length).toBe(1);
    expect(svc.notifications()[0].title).toBe('T');
  });

  it('success delegates to show', () => {
    svc.success('S', 'body');
    expect(svc.notifications()[0].type).toBe('success');
  });

  it('dismiss removes notification', () => {
    const id = svc.info('a', 'b');
    svc.dismiss(id);
    expect(svc.notifications().length).toBe(0);
  });

  it('auto dismisses after duration', fakeAsync(() => {
    svc.show({ type: 'info', title: 't', message: 'm', duration: 10 });
    expect(svc.notifications().length).toBe(1);
    tick(15);
    expect(svc.notifications().length).toBe(0);
  }));
});
