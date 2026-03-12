# DevPilot — Full Local Stack

Run the entire DevPilot stack locally with a single command — no local installs needed beyond Docker.

**What starts:**

| Service | URL | Description |
|---------|-----|-------------|
| Frontend (Angular) | http://localhost | nginx-served SPA |
| Backend (.NET API) | http://localhost:8080/api | REST API + SignalR |
| PostgreSQL | localhost:5432 | Database (auto-migrated on startup) |
| Sandbox Manager | http://localhost:8090 | Python Flask orchestrator |

---

## Quick Start

### 1. Configure secrets

```bash
# macOS / Linux
cp infra/local/.env.example .env
# Edit .env — fill in JWT_SECRET_KEY, GITHUB_CLIENT_ID/SECRET, AI_API_KEY, MANAGER_API_KEY

# Windows
Copy-Item infra\local\.env.example .env
# Edit .env
```

### 2. Start everything

**macOS / Linux:**
```bash
bash infra/local/setup.sh
```

**Windows (PowerShell):**
```powershell
.\infra\local\setup.ps1
```

First run builds all images — takes 10-30 min (devpilot-desktop is the largest).
Subsequent starts take ~30 seconds.

---

## Commands

| Action | macOS/Linux | Windows |
|--------|-------------|---------|
| Start | `bash infra/local/setup.sh` | `.\infra\local\setup.ps1` |
| Rebuild images | `bash infra/local/setup.sh --rebuild` | `.\infra\local\setup.ps1 -Rebuild` |
| Stop | `bash infra/local/setup.sh --stop` | `.\infra\local\setup.ps1 -Stop` |
| Reset (wipe DB) | `bash infra/local/setup.sh --reset` | `.\infra\local\setup.ps1 -Reset` |
| View logs | `docker compose logs -f <service>` | same |

---

## Required `.env` values

| Key | Description |
|-----|-------------|
| `JWT_SECRET_KEY` | JWT signing secret (min 32 chars) |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `AI_API_KEY` | AI provider API key |
| `AI_ENDPOINT` | AI provider base URL |
| `AI_MODEL` | AI model name |
| `MANAGER_API_KEY` | Shared key between backend and sandbox manager |
| `PUBLIC_IP` | IP shown to the browser for VNC/Bridge URLs (`localhost` for local dev) |

Optional (Azure AD):

| Key | Description |
|-----|-------------|
| `AZURE_AD_ENABLED` | Set `true` to enable AzureAD login |
| `AZURE_AD_AUTHORITY` | `https://login.microsoftonline.com/TENANT_ID/v2.0` |
| `AZURE_AD_CLIENT_ID` | Azure AD app client ID |
| `AZURE_AD_TENANT_ID` | Azure AD tenant ID |

---

## How it works

```
docker-compose.yml
├── postgres          ← official image, data in named volume
├── devpilot-backend  ← built from backend/Dockerfile
│     └── on startup: runs EF migrations then starts the API
├── devpilot-frontend ← built from frontend/Dockerfile (nginx)
│     └── nginx proxies /api and /hubs to devpilot-backend
└── sandbox-manager   ← built from infra/sandbox/manager/Dockerfile
      └── mounts Docker socket to create sandbox containers on the host
```

The `devpilot-desktop` image (sandbox containers) is built separately via `setup.sh`
and must exist on the host before you can create sandboxes from the UI.
