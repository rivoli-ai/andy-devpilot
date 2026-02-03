# DevPilot

An AI-powered software development platform that helps teams manage backlogs, analyze repositories, and implement features using AI assistance in isolated cloud sandboxes.

## Features

- **Multi-Provider Repository Sync**: Connect to GitHub and Azure DevOps to sync your repositories
- **AI-Powered Backlog Generation**: Automatically generate Epics, Features, and User Stories from your codebase
- **Azure DevOps Integration**: Import existing work items from Azure DevOps boards
- **Code Browser**: Browse repository code directly in the app (similar to GitHub)
- **AI Implementation Sandboxes**: Spin up isolated VPS environments with Zed IDE and AI assistance
- **Pull Request Automation**: Push changes and create PRs directly from sandboxes
- **Real-time Collaboration**: SignalR-based real-time updates for board changes

## Architecture Overview

DevPilot consists of three main components:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              DevPilot                                    │
├─────────────────┬─────────────────────┬─────────────────────────────────┤
│    Frontend     │      Backend        │           Sandbox               │
│   (Angular 17)  │    (.NET 9 API)     │      (Docker + noVNC)           │
├─────────────────┼─────────────────────┼─────────────────────────────────┤
│ • Modern UI     │ • REST API          │ • Isolated containers           │
│ • OAuth flows   │ • PostgreSQL        │ • Zed IDE + AI                  │
│ • VNC viewer    │ • GitHub/ADO APIs   │ • Git operations                │
│ • Real-time     │ • JWT auth          │ • Bridge API                    │
└─────────────────┴─────────────────────┴─────────────────────────────────┘
```

### Frontend (Angular 17)

Modern single-page application built with Angular 17 featuring:
- Standalone components with signals
- OAuth authentication (GitHub, Microsoft/Azure AD)
- Integrated VNC viewer for remote sandboxes
- Repository code browser with syntax highlighting
- Kanban-style backlog board
- Dark/Light theme support

**Location**: `frontend/`

### Backend (.NET 9)

RESTful API built with .NET 9 following Clean Architecture:
- **API Layer**: Controllers, authentication, SignalR hubs
- **Application Layer**: Commands, queries, DTOs (MediatR pattern)
- **Domain Layer**: Entities, interfaces
- **Infrastructure Layer**: Database, external services (GitHub, Azure DevOps)

**Location**: `src/`

### Sandbox (Docker)

Isolated development environments running on a VPS:
- Ubuntu 24.04 with XFCE desktop
- Zed IDE with AI assistant pre-configured
- noVNC for browser-based remote access
- Bridge API for git operations and communication
- Automatic cleanup after timeout

**Location**: `sandbox/`

## Prerequisites

- **Node.js** 18+ and npm
- **.NET 9 SDK**
- **PostgreSQL** 14+
- **Docker** (for sandbox VPS only)

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/YOUR_USERNAME/DevPilot.git
cd DevPilot
```

### 2. Configure the Backend

```bash
# Copy the template and fill in your credentials
cp src/API/appsettings.Development.json.template src/API/appsettings.Development.json

# Edit with your settings
nano src/API/appsettings.Development.json
```

Required configuration:
- **PostgreSQL**: Connection string
- **JWT**: Secret key (32+ characters)
- **GitHub OAuth**: Client ID and Secret (create at https://github.com/settings/developers)
- **Microsoft OAuth**: Client ID, Secret, Tenant ID (Azure Portal)

### 3. Setup Database

```bash
cd src/API

# Apply migrations
dotnet ef database update
```

### 4. Start the Backend

```bash
cd src/API
dotnet run
```

The API will be available at `http://localhost:5089`

### 5. Start the Frontend

```bash
cd frontend
npm install
npm start
```

The app will be available at `http://localhost:4200`

### 6. (Optional) Setup Sandbox VPS

If you want AI-powered implementation sandboxes, see [Sandbox Setup Guide](docs/VPS_SANDBOX_CONNECTION_GUIDE.md).

## Configuration

### Environment Variables

All sensitive configuration should be in `appsettings.Development.json` (gitignored):

```json
{
  "ConnectionStrings": {
    "Postgres": "Host=localhost;Port=5432;Username=user;Password=pass;Database=devpilot"
  },
  "JWT": {
    "SecretKey": "your-secret-key-min-32-characters"
  },
  "GitHub": {
    "ClientId": "your-github-oauth-client-id",
    "ClientSecret": "your-github-oauth-client-secret"
  },
  "Microsoft": {
    "ClientId": "your-azure-ad-client-id",
    "ClientSecret": "your-azure-ad-client-secret",
    "TenantId": "your-tenant-id"
  }
}
```

### OAuth Setup

#### GitHub OAuth App
1. Go to https://github.com/settings/developers
2. Create new OAuth App
3. Set callback URL: `http://localhost:4200/auth/callback`
4. Copy Client ID and Client Secret

#### Microsoft/Azure AD
1. Go to Azure Portal > App registrations
2. Create new registration
3. Set redirect URI: `http://localhost:4200/auth/callback/microsoft`
4. Create client secret
5. Copy Application ID, Client Secret, and Tenant ID

## Project Structure

```
DevPilot/
├── frontend/                 # Angular 17 frontend
│   ├── src/
│   │   ├── app/
│   │   │   ├── core/        # Services, guards, interceptors
│   │   │   ├── features/    # Feature modules (backlog, code, settings)
│   │   │   ├── components/  # Shared components
│   │   │   └── layout/      # Layout components (sidebar, header)
│   │   └── environments/
│   └── package.json
│
├── src/                      # .NET Backend
│   ├── API/                 # Web API layer
│   │   ├── Controllers/     # REST endpoints
│   │   └── Hubs/           # SignalR hubs
│   ├── Application/         # Business logic
│   │   ├── Commands/       # Write operations
│   │   ├── Queries/        # Read operations
│   │   └── UseCases/       # Handlers
│   ├── Domain/              # Entities & interfaces
│   └── Infrastructure/      # External services
│       ├── GitHub/         # GitHub API integration
│       ├── AzureDevOps/    # Azure DevOps API
│       ├── Persistence/    # Database repositories
│       └── Migrations/     # EF Core migrations
│
├── sandbox/                  # VPS sandbox setup
│   ├── setup.sh            # Installation script
│   └── README.md           # Sandbox documentation
│
└── docs/                     # Documentation
    ├── VPS_SETUP_GUIDE.md
    ├── VPS_QUICK_START.md
    └── VPS_SANDBOX_CONNECTION_GUIDE.md
```

## Key Features Explained

### Repository Sync
- Connect GitHub or Azure DevOps accounts via OAuth
- Or use Personal Access Tokens (PAT) for Azure DevOps
- Automatically syncs all accessible repositories

### AI Backlog Generation
- Analyzes repository code structure
- Generates hierarchical backlog: Epics → Features → User Stories
- Customizable AI providers (OpenAI, Anthropic, Ollama, custom)

### Code Browser
- Browse files and directories
- Syntax highlighting for 50+ languages
- View branches and switch between them
- Pull request listing

### Implementation Sandboxes
- Click "Start Implementation" on any user story
- Spawns isolated Docker container with:
  - Full desktop environment (XFCE)
  - Zed IDE with AI assistant
  - Repository pre-cloned
  - Git credentials configured
- Push changes and create PR directly from sandbox

## API Endpoints

### Authentication
- `POST /api/auth/login` - Email/password login
- `POST /api/auth/register` - Create account
- `POST /api/auth/github/callback` - GitHub OAuth
- `POST /api/auth/microsoft/callback` - Microsoft OAuth

### Repositories
- `GET /api/repositories` - List user's repositories
- `POST /api/repositories/sync/github` - Sync from GitHub
- `POST /api/repositories/sync/azure-devops` - Sync from Azure DevOps
- `GET /api/repositories/{id}/tree` - Browse repository files

### Backlog
- `GET /api/backlog/{repositoryId}` - Get backlog items
- `POST /api/backlog/generate` - AI generate backlog
- `PUT /api/backlog/stories/{id}/status` - Update story status

## Development

### Backend

```bash
cd src/API

# Run with hot reload
dotnet watch run

# Run tests
dotnet test

# Add migration
dotnet ef migrations add MigrationName

# Apply migrations
dotnet ef database update
```

### Frontend

```bash
cd frontend

# Development server with hot reload
npm start

# Build for production
npm run build

# Run tests
npm test

# Lint
npm run lint
```

## Troubleshooting

### Database connection failed
- Ensure PostgreSQL is running
- Check connection string in appsettings.Development.json
- Verify database exists

### OAuth callback fails
- Verify redirect URIs match exactly
- Check Client ID and Secret are correct
- Ensure app is registered for correct scopes

### Sandbox not connecting
- Check VPS firewall allows ports 8090 and 6100-6200
- Verify Docker is installed and running on VPS
- Check sandbox manager logs: `journalctl -u devpilot-sandbox -f`

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit changes: `git commit -m 'Add my feature'`
4. Push to branch: `git push origin feature/my-feature`
5. Open a Pull Request

## License

MIT License - see LICENSE file for details.
