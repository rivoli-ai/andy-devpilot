# DevPilot Backend

.NET 9 Web API following Clean Architecture principles.

---

## Tech Stack

- **.NET 9** Web API
- **Entity Framework Core** with PostgreSQL
- **MediatR** for CQRS pattern
- **SignalR** for real-time communication
- **Octokit** for GitHub API integration
- **JWT** for authentication

---

## Architecture

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

---

## Project structure

```
src/
├── API/
│   ├── Controllers/
│   │   ├── AuthController.cs
│   │   ├── RepositoriesController.cs
│   │   ├── BacklogController.cs
│   │   └── SandboxController.cs
│   ├── Hubs/
│   │   └── BoardHub.cs
│   ├── appsettings.json
│   ├── appsettings.Development.json   ← gitignored, create from template
│   └── Program.cs
├── Application/
│   ├── Commands/
│   ├── Queries/
│   ├── UseCases/
│   ├── DTOs/
│   └── Services/
├── Domain/
│   ├── Entities/
│   └── Interfaces/
└── Infrastructure/
    ├── Persistence/
    ├── GitHub/
    ├── AzureDevOps/
    ├── AI/
    ├── Sandbox/
    └── Migrations/
```

---

## Run locally (native)

### Prerequisites

- .NET 9 SDK — https://dotnet.microsoft.com/download
- PostgreSQL 14+ running locally

### 1. Create the config file

`appsettings.Development.json` is gitignored. Create it:

```bash
cp src/API/appsettings.json src/API/appsettings.Development.json
```

Then fill in the values (see [Configuration reference](#configuration-reference) below).

### 2. Run database migrations

```bash
cd src/API
dotnet ef database update
```

### 3. Start the API

```bash
cd src/API
dotnet run
# or with hot reload:
dotnet watch run
```

API available at `http://localhost:8080`.

### Environment variables (optional — overrides appsettings)

You can use env vars instead of editing `appsettings.Development.json`.
ASP.NET Core maps `VPS__ManagerApiKey` → `VPS:ManagerApiKey` automatically (double underscore = colon).

```bash
# Load from .env file at repo root
set -a; source .env; set +a
dotnet run --project src/API
```

---

## Run with Docker

> No Dockerfile exists yet. Here is what to create as `backend/Dockerfile`:

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY src/ .
RUN dotnet publish API/API.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
COPY --from=build /app/publish .
EXPOSE 8080
ENTRYPOINT ["dotnet", "API.dll"]
```

Build and run:

```bash
docker build -t devpilot-backend:local -f backend/Dockerfile backend/

docker run -d \
  --name devpilot-backend \
  -p 8080:8080 \
  -e ASPNETCORE_ENVIRONMENT=Development \
  -e ConnectionStrings__Postgres="Host=host.docker.internal;Port=5432;Username=analyser;Password=analyser_password;Database=analyzer" \
  -e JWT__SecretKey="your-32-char-secret" \
  -e VPS__GatewayUrl="http://host.docker.internal:30090" \
  -e VPS__ManagerApiKey="your_manager_api_key" \
  -e VPS__PublicIp="localhost" \
  -e VPS__Enabled="true" \
  devpilot-backend:local
```

> Use `host.docker.internal` to reach services on your host machine from inside Docker.

---

## Deploy to Kubernetes / AKS

### What's already ready

| Component | File |
|-----------|------|
| K8s Deployment + ClusterIP Service | `infra/k8s/manifests/backend-deployment.yaml` |
| Secret template (all config keys) | `infra/k8s/manifests/backend-secret.yaml.template` |

### Steps

1. **Build and push the backend image** to GHCR or ACR:

```bash
docker build -t ghcr.io/YOUR_ORG/devpilot-backend:latest -f backend/Dockerfile backend/
docker push ghcr.io/YOUR_ORG/devpilot-backend:latest
```

2. **Update the image reference** in `infra/k8s/manifests/backend-deployment.yaml`:
```yaml
image: ghcr.io/YOUR_ORG/devpilot-backend:latest
```

3. **Create the namespace** (if not already done):
```bash
kubectl create namespace devpilot
```

4. **Create the K8s Secret** — never commit the secret file:

```bash
cp infra/k8s/manifests/backend-secret.yaml.template infra/k8s/manifests/backend-secret.yaml
# Edit backend-secret.yaml with real values, then:
kubectl apply -f infra/k8s/manifests/backend-secret.yaml
```

Or directly via `kubectl`:
```bash
kubectl create secret generic backend-secrets -n devpilot \
  --from-literal=ConnectionStrings__Postgres="Host=YOUR_DB;Username=...;Password=...;Database=analyzer" \
  --from-literal=JWT__SecretKey="YOUR_STRONG_SECRET" \
  --from-literal=AuthProviders__GitHub__ClientSecret="YOUR_GITHUB_SECRET" \
  --from-literal=AI__ApiKey="YOUR_AI_KEY" \
  --from-literal=VPS__GatewayUrl="http://sandbox-manager.sandboxes.svc.cluster.local:8090" \
  --from-literal=VPS__ManagerApiKey="YOUR_MANAGER_API_KEY" \
  --from-literal=VPS__PublicIp="YOUR_NODE_PUBLIC_IP"
```

5. **Apply the deployment**:

```bash
kubectl apply -f infra/k8s/manifests/backend-deployment.yaml
kubectl get pods -n devpilot
kubectl logs -f deployment/devpilot-backend -n devpilot
```

> On AKS, env vars from the K8s Secret are injected via `envFrom: secretRef`.
> ASP.NET Core picks them up automatically — no code changes needed.

---

## Configuration reference

All values go in `appsettings.Development.json` (local) or K8s Secret (production).

| Key | Description | Example |
|-----|-------------|---------|
| `ConnectionStrings:Postgres` | PostgreSQL connection string | `Host=localhost;Port=5432;...` |
| `JWT:SecretKey` | JWT signing key (min 32 chars) | `your-strong-secret-key-here` |
| `AuthProviders:GitHub:ClientId` | GitHub OAuth app client ID | `Ov23ligXXXXXXX` |
| `AuthProviders:GitHub:ClientSecret` | GitHub OAuth app client secret | `25a66c...` |
| `AuthProviders:AzureAd:Authority` | Azure AD login endpoint | `https://login.microsoftonline.com/TENANT_ID/v2.0` |
| `AuthProviders:AzureAd:ClientId` | Azure AD app client ID | `dec5414a-...` |
| `AuthProviders:AzureAd:TenantId` | Azure AD tenant ID | `1335991b-...` |
| `AI:Endpoint` | AI provider base URL | `https://router.huggingface.co/v1` |
| `AI:ApiKey` | AI provider API key | `hf_XXX...` |
| `AI:Model` | AI model name | `Qwen/Qwen3-30B-A3B-Instruct-2507` |
| `VPS:GatewayUrl` | Sandbox manager URL | `http://localhost:30090` |
| `VPS:ManagerApiKey` | Shared key with sandbox manager | same as `MANAGER_API_KEY` in manager `.env` |
| `VPS:PublicIp` | Host IP shown to browser for VNC/bridge | `localhost` or real IP |
| `VPS:Enabled` | Enable/disable sandbox features | `true` |

---

## API endpoints

### Authentication (`/api/auth`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/login` | Email/password login |
| POST | `/register` | Create account |
| POST | `/github/callback` | GitHub OAuth callback |
| POST | `/microsoft/callback` | Microsoft OAuth callback |
| GET | `/settings` | Get user settings |
| POST | `/settings/ai` | Save AI configuration |

### Repositories (`/api/repositories`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List repositories |
| POST | `/sync/github` | Sync from GitHub |
| POST | `/sync/azure-devops` | Sync from Azure DevOps |
| GET | `/{id}/tree` | Browse files |
| GET | `/{id}/branches` | List branches |
| GET | `/{id}/pull-requests` | List PRs |
| POST | `/{id}/pull-requests` | Create PR |

### Backlog (`/api/backlog`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/{repositoryId}` | Get backlog |
| POST | `/generate` | AI generate backlog |
| POST | `/epics` | Create epic |
| PUT | `/epics/{id}` | Update epic |
| POST | `/features` | Create feature |
| POST | `/stories` | Create story |
| PUT | `/stories/{id}/status` | Update story status |

### Sandboxes (`/api/sandboxes`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List user's active sandboxes |
| POST | `/` | Create a sandbox |
| GET | `/{id}` | Get sandbox status |
| DELETE | `/{id}` | Delete sandbox |

---

## Database migrations

```bash
cd src/API

# Apply pending migrations
dotnet ef database update

# Create a new migration
dotnet ef migrations add MigrationName --project ../Infrastructure

# Generate SQL script
dotnet ef migrations script
```

---

## Troubleshooting

### Port already in use

```bash
lsof -i :8080
kill -9 <PID>
```

### Cannot connect to sandbox manager (Connection refused)

- Check `VPS:GatewayUrl` in your config
- Local Docker: use `http://localhost:8090`
- K8s local: use `http://localhost:30090`
- K8s production: use `http://sandbox-manager.sandboxes.svc.cluster.local:8090`

### 401 from sandbox manager

- Check `VPS:ManagerApiKey` matches `MANAGER_API_KEY` in the manager's `.env` or K8s secret
- No trailing spaces or `%` character at end of key

### EF migrations fail

```bash
dotnet ef database update --verbose
# Check the Postgres connection string
```
