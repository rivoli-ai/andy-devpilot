# DevPilot Backend

.NET 9 Web API following Clean Architecture principles.

## Tech Stack

- **.NET 9** Web API
- **Entity Framework Core** with PostgreSQL
- **MediatR** for CQRS pattern
- **SignalR** for real-time communication
- **Octokit** for GitHub API
- **JWT** for authentication

## Architecture

The backend follows Clean Architecture with four layers:

```
┌─────────────────────────────────────────┐
│              API Layer                  │
│  Controllers, Hubs, Middleware          │
├─────────────────────────────────────────┤
│          Application Layer              │
│  Commands, Queries, Handlers, DTOs      │
├─────────────────────────────────────────┤
│            Domain Layer                 │
│  Entities, Interfaces, Value Objects    │
├─────────────────────────────────────────┤
│        Infrastructure Layer             │
│  Database, External APIs, Services      │
└─────────────────────────────────────────┘
```

### API Layer (`API/`)

- **Controllers**: REST endpoints for all operations
- **Hubs**: SignalR hubs for real-time features
- **Program.cs**: Service configuration and middleware

### Application Layer (`Application/`)

- **Commands**: Write operations (create, update, delete)
- **Queries**: Read operations
- **UseCases**: MediatR handlers for commands/queries
- **DTOs**: Data transfer objects
- **Services**: Application service interfaces

### Domain Layer (`Domain/`)

- **Entities**: Business objects (User, Repository, Epic, Feature, UserStory)
- **Interfaces**: Repository interfaces

### Infrastructure Layer (`Infrastructure/`)

- **Persistence**: EF Core DbContext, repository implementations
- **GitHub**: GitHub API integration using Octokit
- **AzureDevOps**: Azure DevOps REST API integration
- **AI**: AI analysis service
- **Migrations**: Database migrations

## Project Structure

```
src/
├── API/
│   ├── Controllers/
│   │   ├── AuthController.cs      # Authentication & OAuth
│   │   ├── RepositoriesController.cs  # Repository operations
│   │   └── BacklogController.cs   # Backlog management
│   ├── Hubs/
│   │   └── BoardHub.cs           # Real-time board updates
│   ├── appsettings.json          # Configuration (templates)
│   └── Program.cs                # Entry point & DI setup
│
├── Application/
│   ├── Commands/                 # Write operations
│   ├── Queries/                  # Read operations
│   ├── UseCases/                 # MediatR handlers
│   ├── DTOs/                     # Data transfer objects
│   └── Services/                 # Service interfaces
│
├── Domain/
│   ├── Entities/                 # Business entities
│   │   ├── User.cs
│   │   ├── Repository.cs
│   │   ├── Epic.cs
│   │   ├── Feature.cs
│   │   ├── UserStory.cs
│   │   └── LinkedProvider.cs
│   └── Interfaces/               # Repository interfaces
│
└── Infrastructure/
    ├── Persistence/              # EF Core implementation
    │   ├── DevPilotDbContext.cs
    │   └── Postgres*Repository.cs
    ├── GitHub/                   # GitHub API
    │   └── GitHubService.cs
    ├── AzureDevOps/              # Azure DevOps API
    │   └── AzureDevOpsService.cs
    ├── AI/                       # AI services
    └── Migrations/               # Database migrations
```

## Getting Started

### Prerequisites

- .NET 9 SDK
- PostgreSQL 14+

### Configuration

Copy and configure the settings file:

```bash
cp API/appsettings.Development.json.template API/appsettings.Development.json
```

Edit `appsettings.Development.json`:

```json
{
  "ConnectionStrings": {
    "Postgres": "Host=localhost;Port=5432;Username=user;Password=pass;Database=devpilot"
  },
  "JWT": {
    "SecretKey": "your-32-character-minimum-secret-key"
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

### Database Setup

```bash
cd API

# Create database (if not exists)
# Via psql: CREATE DATABASE devpilot;

# Apply migrations
dotnet ef database update
```

### Running

```bash
cd API

# Development with hot reload
dotnet watch run

# Or standard run
dotnet run
```

API available at `http://localhost:5089`

## API Endpoints

### Authentication (`/api/auth`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/login` | Email/password login |
| POST | `/register` | Create new account |
| POST | `/github/callback` | GitHub OAuth callback |
| POST | `/microsoft/callback` | Microsoft OAuth callback |
| POST | `/link/github` | Link GitHub account |
| POST | `/link/azure-devops` | Link Azure DevOps |
| GET | `/settings` | Get user settings |
| POST | `/settings/azure-devops` | Save Azure DevOps settings |
| GET | `/settings/ai` | Get AI configuration |
| POST | `/settings/ai` | Save AI configuration |

### Repositories (`/api/repositories`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List user's repositories |
| POST | `/sync/github` | Sync from GitHub |
| POST | `/sync/azure-devops` | Sync from Azure DevOps |
| GET | `/{id}/tree` | Browse repository files |
| GET | `/{id}/file` | Get file content |
| GET | `/{id}/branches` | List branches |
| GET | `/{id}/pull-requests` | List PRs |
| POST | `/{id}/pull-requests` | Create PR |
| GET | `/{id}/clone-url` | Get authenticated clone URL |

### Backlog (`/api/backlog`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/{repositoryId}` | Get backlog items |
| POST | `/generate` | AI generate backlog |
| POST | `/epics` | Create epic |
| PUT | `/epics/{id}` | Update epic |
| DELETE | `/epics/{id}` | Delete epic |
| POST | `/features` | Create feature |
| PUT | `/features/{id}` | Update feature |
| DELETE | `/features/{id}` | Delete feature |
| POST | `/stories` | Create user story |
| PUT | `/stories/{id}` | Update story |
| PUT | `/stories/{id}/status` | Update story status |
| DELETE | `/stories/{id}` | Delete story |

## Database Migrations

```bash
cd API

# Create new migration
dotnet ef migrations add MigrationName

# Apply migrations
dotnet ef database update

# Revert last migration
dotnet ef database update PreviousMigrationName

# Generate SQL script
dotnet ef migrations script
```

## Testing

```bash
# Run all tests
dotnet test

# Run with coverage
dotnet test --collect:"XPlat Code Coverage"
```

## Key Services

### GitHubService
- Repository listing and sync
- File content retrieval
- Pull request management
- Uses Octokit library

### AzureDevOpsService
- Repository listing
- Work items (WIQL queries)
- Pull request management
- Uses REST API directly

### AuthenticationService
- JWT token generation
- OAuth token exchange
- User session management

## Security

- JWT tokens for API authentication
- OAuth 2.0 for GitHub/Microsoft login
- PAT support for Azure DevOps
- Credentials stored encrypted in database
- CORS configured for frontend origin
