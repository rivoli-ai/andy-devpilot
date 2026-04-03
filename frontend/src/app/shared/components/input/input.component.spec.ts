import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { InputComponent } from './input.component';

describe('InputComponent', () => {
  let fixture: ComponentFixture<InputComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InputComponent, FormsModule],
    }).compileComponents();
    fixture = TestBed.createComponent(InputComponent);
  });

  it('creates with defaults', () => {
    fixture.detectChanges();
    expect(fixture.componentInstance.type()).toBe('text');
    expect(fixture.componentInstance.disabled()).toBe(false);
  });
});
