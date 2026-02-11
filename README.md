# DevPilot

AI-powered development assistant that analyzes repositories, generates backlogs, and manages project workflows across GitHub and Azure DevOps.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | .NET 9, ASP.NET Core, Entity Framework Core, PostgreSQL |
| **Frontend** | Angular 17, TypeScript, angular-auth-oidc-client |
| **Identity** | Duende IdentityServer (TheIdServer) |
| **Real-time** | SignalR |
| **AI** | Hugging Face Inference API |
| **Sandbox** | Docker-in-Docker, noVNC, Zed Editor |

## Project Structure

```
andy-devpilot/
  backend/                 .NET solution (Clean Architecture)
    src/
      API/                 ASP.NET Core Web API + SignalR hubs
      Application/         CQRS commands, queries, use cases
      Domain/              Entities and repository interfaces
      Infrastructure/      EF Core, GitHub, Azure DevOps, AI integrations
    DevPilot.sln
  frontend/                Angular 17 SPA
    src/
      app/
        core/              Auth, services, interceptors
        features/          Backlog, repositories, settings, code analysis
        shared/            Reusable components, models, pipes
        layout/            Header, sidebar
  infra/
    identity/              Duende IdentityServer (Docker Compose + install scripts)
    sandbox/               Remote sandbox environment (Docker-in-Docker + noVNC)
  docs/                    Architecture and setup guides
  .vscode/                 VS Code launch/task configurations
```

## Getting Started

### Prerequisites

- [.NET 9 SDK](https://dotnet.microsoft.com/download)
- [Node.js 18+](https://nodejs.org/)
- [Docker](https://www.docker.com/) (for Identity Server)
- PostgreSQL (or use the in-memory provider for local dev)

### Backend

```bash
cd backend/src/API
cp appsettings.Development.json.template appsettings.Development.json
# Edit appsettings.Development.json with your settings
dotnet run
```

The API starts on `http://localhost:8080`.

### Frontend

```bash
cd frontend
npm install
npm start
```

The app opens at `http://localhost:4200`.

### Identity Server (optional)

```bash
cd infra/identity
./install.sh            # macOS/Linux
# .\install.ps1         # Windows
```

Admin UI available at `https://localhost:5001`.

## Documentation

- [VPS Quick Start](docs/VPS_QUICK_START.md)
- [VPS Setup Guide](docs/VPS_SETUP_GUIDE.md)
- [Sandbox Connection Guide](docs/VPS_SANDBOX_CONNECTION_GUIDE.md)
- [Architecture: VPS Analysis](docs/ARCHITECTURE_VPS_ANALYSIS.md)
- [Local Sandbox Debug](docs/LOCAL_SANDBOX_DEBUG.md)

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
