import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ButtonComponent } from './button.component';

describe('ButtonComponent', () => {
  let fixture: ComponentFixture<ButtonComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ButtonComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(ButtonComponent);
  });

  it('creates with default inputs', () => {
    fixture.detectChanges();
    expect(fixture.componentInstance.variant()).toBe('primary');
    expect(fixture.componentInstance.size()).toBe('md');
    expect(fixture.componentInstance.disabled()).toBe(false);
  });
});
