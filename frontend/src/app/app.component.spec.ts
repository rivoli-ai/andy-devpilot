import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BehaviorSubject, Subject, of } from 'rxjs';
import { AppComponent } from './app.component';
import { ThemeService } from './core/services/theme.service';
import { MermaidDiagramService } from './core/services/mermaid-diagram.service';
import { VncViewerService } from './core/services/vnc-viewer.service';
import { SandboxService } from './core/services/sandbox.service';
import { AuthService } from './core/services/auth.service';

describe('AppComponent', () => {
  let viewers$: BehaviorSubject<unknown[]>;
  let viewerClosed$: Subject<string>;

  beforeEach(async () => {
    viewers$ = new BehaviorSubject<unknown[]>([]);
    viewerClosed$ = new Subject<string>();

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        ThemeService,
        { provide: MermaidDiagramService, useValue: { rerenderAllDiagrams: () => {} } },
        {
          provide: VncViewerService,
          useValue: {
            viewers$: viewers$.asObservable(),
            viewerClosed$: viewerClosed$.asObservable()
          }
        },
        {
          provide: SandboxService,
          useValue: {
            deleteSandbox: jasmine.createSpy('deleteSandbox').and.returnValue(of(true)),
            listSandboxes: () => of([]),
          }
        },
        {
          provide: AuthService,
          useValue: { isLoggedIn: (): boolean => false }
        }
      ]
    }).compileComponents();
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should update viewers when VncViewerService emits', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    fixture.detectChanges();
    viewers$.next([
      {
        id: '1',
        config: { port: 1 },
        dockPosition: 'tiled',
        createdAt: Date.now()
      }
    ]);
    expect(app.vncViewers().length).toBe(1);
  });
});
