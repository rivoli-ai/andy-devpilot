# DevPilot Design System

## Overview

This design system provides a consistent, scalable foundation for building UI components across the DevPilot application. It uses CSS custom properties (variables) for theming and modular, reusable components.

## Design Tokens

### Colors

The design system uses a comprehensive color palette organized by purpose:

#### Primary Colors
- `--color-primary-50` to `--color-primary-900`: Gradient from light to dark

#### Secondary Colors
- `--color-secondary-50` to `--color-secondary-900`: Gradient from light to dark

#### Neutral Colors
- `--color-gray-50` to `--color-gray-900`: Grayscale palette

#### Semantic Colors
- Success: `--color-success`, `--color-success-light`
- Warning: `--color-warning`, `--color-warning-light`
- Error: `--color-error`, `--color-error-light`
- Info: `--color-info`, `--color-info-light`

### Typography

#### Font Families
- `--font-family-sans`: System sans-serif stack
- `--font-family-mono`: Monospace font stack

#### Font Sizes
- `--font-size-xs`: 0.75rem (12px)
- `--font-size-sm`: 0.875rem (14px)
- `--font-size-base`: 1rem (16px)
- `--font-size-lg`: 1.125rem (18px)
- `--font-size-xl`: 1.25rem (20px)
- `--font-size-2xl`: 1.5rem (24px)
- `--font-size-3xl`: 1.875rem (30px)
- `--font-size-4xl`: 2.25rem (36px)

#### Font Weights
- `--font-weight-normal`: 400
- `--font-weight-medium`: 500
- `--font-weight-semibold`: 600
- `--font-weight-bold`: 700

### Spacing

Uses a consistent 4px base unit:
- `--spacing-1`: 4px
- `--spacing-2`: 8px
- `--spacing-3`: 12px
- `--spacing-4`: 16px
- ... up to `--spacing-24`: 96px

### Border Radius

- `--radius-sm`: 4px
- `--radius-base`: 6px
- `--radius-md`: 8px
- `--radius-lg`: 12px
- `--radius-xl`: 16px
- `--radius-full`: 9999px (for circles/pills)

### Shadows

- `--shadow-sm`: Subtle shadow for elevation
- `--shadow-base`: Default shadow
- `--shadow-md`: Medium elevation
- `--shadow-lg`: Large elevation
- `--shadow-xl`: Extra large elevation
- `--shadow-2xl`: Maximum elevation

### Transitions

- `--transition-fast`: 150ms
- `--transition-base`: 200ms
- `--transition-slow`: 300ms

All use `cubic-bezier(0.4, 0, 0.2, 1)` easing.

## Shared Components

### Button (`app-button`)

A versatile button component with multiple variants and sizes.

**Usage:**
```html
<app-button variant="primary" size="md">Click me</app-button>
```

**Inputs:**
- `variant`: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'ghost'
- `size`: 'sm' | 'md' | 'lg'
- `disabled`: boolean
- `loading`: boolean
- `fullWidth`: boolean

### Card (`app-card`)

Container component for grouping related content.

**Usage:**
```html
<app-card padding="md" [hoverable]="true">
  <h3>Card Title</h3>
  <p>Card content</p>
</app-card>
```

**Inputs:**
- `padding`: 'none' | 'sm' | 'md' | 'lg'
- `hoverable`: boolean

### Badge (`app-badge`)

Small label component for status indicators.

**Usage:**
```html
<app-badge variant="success">Active</app-badge>
```

**Inputs:**
- `variant`: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info'

### Input (`app-input`)

Form input component with label and error handling.

**Usage:**
```html
<app-input 
  label="Email"
  type="email"
  placeholder="Enter your email"
  [required]="true"
  [error]="emailError"
  [(ngModel)]="email" />
```

**Inputs:**
- `type`: 'text' | 'email' | 'password' | 'number' | 'tel' | 'url'
- `label`: string
- `placeholder`: string
- `error`: string | null
- `disabled`: boolean
- `required`: boolean
- `size`: 'sm' | 'md' | 'lg'

## Component Structure

```
src/app/
├── shared/
│   └── components/
│       ├── button/
│       │   ├── button.component.ts
│       │   ├── button.component.html
│       │   └── button.component.css
│       ├── card/
│       ├── badge/
│       ├── input/
│       └── index.ts (barrel export)
├── layout/
│   ├── sidebar/
│   └── header/
└── styles.css (design system variables)
```

## Best Practices

1. **Always use design tokens**: Use CSS variables instead of hardcoded values
2. **Component composition**: Build complex UIs from granular components
3. **Consistent spacing**: Use spacing variables for margins and padding
4. **Semantic colors**: Use semantic color variables (success, error) for meaning
5. **Accessibility**: Ensure proper contrast ratios and ARIA attributes
6. **Responsive design**: Use CSS media queries with design tokens

## Usage Example

```typescript
import { ButtonComponent, CardComponent, BadgeComponent } from '@shared/components';

@Component({
  imports: [ButtonComponent, CardComponent, BadgeComponent]
})
export class MyComponent {}
```

```html
<app-card padding="md">
  <h2>Repository List</h2>
  <app-badge variant="success">Active</app-badge>
  <app-button variant="primary" size="md">
    Sync Repositories
  </app-button>
</app-card>
```
