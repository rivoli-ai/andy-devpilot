# DevPilot Frontend

Modern Angular 17 single-page application for DevPilot.

## Tech Stack

- **Angular 17** with standalone components
- **Signals** for reactive state management
- **RxJS** for async operations
- **TypeScript** 5.x
- **SCSS** for styling

## Features

- OAuth authentication (GitHub, Microsoft)
- Repository management and sync
- Code browser with syntax highlighting
- Kanban backlog board
- Integrated VNC viewer for sandboxes
- Dark/Light theme support
- Responsive design

## Project Structure

```
src/app/
├── core/                    # Core functionality
│   ├── guards/             # Route guards
│   ├── interceptors/       # HTTP interceptors
│   └── services/           # Application services
│       ├── auth.service.ts
│       ├── repository.service.ts
│       ├── backlog.service.ts
│       ├── sandbox.service.ts
│       └── ai-config.service.ts
│
├── features/               # Feature modules
│   ├── backlog/           # Backlog management
│   ├── code/              # Code browser
│   ├── repositories/      # Repository list
│   ├── settings/          # User settings
│   └── login/             # Authentication
│
├── components/             # Shared components
│   ├── vnc-viewer/        # VNC remote viewer
│   ├── card/              # Card component
│   └── backlog-generator/ # AI backlog modal
│
├── layout/                 # Layout components
│   ├── sidebar/
│   └── header/
│
└── shared/                 # Shared utilities
    ├── models/
    └── pipes/
```

## Development

### Prerequisites

- Node.js 18+
- npm 9+

### Installation

```bash
npm install
```

### Development Server

```bash
npm start
# or
ng serve
```

Navigate to `http://localhost:4200`. The app auto-reloads on changes.

### Build

```bash
# Development build
npm run build

# Production build
npm run build -- --configuration production
```

Build artifacts are in the `dist/` directory.

### Testing

```bash
# Unit tests
npm test

# E2E tests (requires setup)
npm run e2e
```

### Linting

```bash
npm run lint
```

## Environment Configuration

Edit `src/environments/environment.ts` for development:

```typescript
export const environment = {
  production: false,
  apiUrl: 'http://localhost:5089/api'
};
```

## Key Services

### AuthService
Handles authentication, OAuth flows, user management.

### RepositoryService
Repository CRUD, sync operations, code browsing.

### BacklogService
Backlog items, AI generation, Azure DevOps import.

### SandboxService
VPS sandbox creation and management.

### VncViewerService
Manages VNC viewer instances for remote sandboxes.

## Styling

The app uses CSS custom properties for theming:

```css
:root {
  --bg-primary: #1a1a2e;
  --text-primary: #ffffff;
  --accent-color: #6366f1;
  /* ... */
}

[data-theme="light"] {
  --bg-primary: #ffffff;
  --text-primary: #1f2937;
  /* ... */
}
```

## Component Examples

### Standalone Component

```typescript
@Component({
  selector: 'app-example',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `...`
})
export class ExampleComponent {
  // Using signals
  data = signal<Data[]>([]);
  loading = signal(false);
  
  // Computed values
  filteredData = computed(() => 
    this.data().filter(d => d.active)
  );
}
```

## Further Help

- [Angular Documentation](https://angular.io/docs)
- [Angular CLI Reference](https://angular.io/cli)
