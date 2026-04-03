import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { ThemeService } from './theme.service';
import { MermaidDiagramService } from './mermaid-diagram.service';

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.removeItem('devpilot-theme');
    document.documentElement.removeAttribute('data-theme');
    document.body.classList.remove('dark-theme', 'light-theme');
  });

  it('toggle flips theme and persists', fakeAsync(() => {
    const mermaid = jasmine.createSpyObj<MermaidDiagramService>('MermaidDiagramService', ['rerenderAllDiagrams']);
    TestBed.configureTestingModule({
      providers: [
        ThemeService,
        { provide: MermaidDiagramService, useValue: mermaid },
      ],
    });
    const svc = TestBed.inject(ThemeService);
    tick();
    const before = svc.theme();
    svc.toggle();
    tick();
    expect(svc.theme()).not.toBe(before);
    expect(localStorage.getItem('devpilot-theme')).toBe(svc.theme());
  }));

  it('setTheme updates document', fakeAsync(() => {
    const mermaid = jasmine.createSpyObj<MermaidDiagramService>('MermaidDiagramService', ['rerenderAllDiagrams']);
    TestBed.configureTestingModule({
      providers: [
        ThemeService,
        { provide: MermaidDiagramService, useValue: mermaid },
      ],
    });
    const svc = TestBed.inject(ThemeService);
    tick();
    svc.setTheme('dark');
    tick();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  }));
});
