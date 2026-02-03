import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Reusable card component
 */
@Component({
  selector: 'app-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './card.component.html',
  styleUrl: './card.component.css'
})
export class CardComponent {
  padding = input<'none' | 'sm' | 'md' | 'lg'>('md');
  hoverable = input<boolean>(false);
}
