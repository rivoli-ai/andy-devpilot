import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CardComponent } from './card.component';

describe('CardComponent', () => {
  let fixture: ComponentFixture<CardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [CardComponent] }).compileComponents();
    fixture = TestBed.createComponent(CardComponent);
  });

  it('defaults', () => {
    fixture.detectChanges();
    expect(fixture.componentInstance.padding()).toBe('md');
    expect(fixture.componentInstance.hoverable()).toBe(false);
  });
});
