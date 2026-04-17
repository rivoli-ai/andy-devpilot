# DevPilot Sandbox

Multi-container sandbox system that creates isolated desktop environments on demand.
Each sandbox is an independent container with its own XFCE desktop, Zed IDE, and bridge API.

---

## Architecture

**Docker mode** (Linux / macOS / Windows — `BACKEND=docker`)
```
Browser (Angular)
       │  JWT
       ▼
┌──────────────────────┐
│   .NET Backend API   │  port 8080
└──────────┬───────────┘
           │  X-Api-Key  →  http://HOST:8090
           ▼
┌──────────────────────┐        ┌────────────────────────────────────────────┐
│   Sandbox Manager    │        │                  Host / VPS                │
│   Flask  :8090       │───────▶│  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│   BACKEND=docker     │        │  │ Sandbox  │  │ Sandbox  │  │  ...     │ │
└──────────────────────┘        │  │  noVNC   │  │  noVNC   │  │          │ │
                                │  │  :6100   │  │  :6101   │  │          │ │
                                │  │  Bridge  │  │  Bridge  │  │          │ │
                                │  │  :7100   │  │  :7101   │  │          │ │
                                │  └──────────┘  └──────────┘  └──────────┘ │
                                └────────────────────────────────────────────┘
Browser → sandbox Bridge:  Authorization: Bearer <sandbox_token>  →  http://HOST:7100/...
```

**Kubernetes mode** (local K8s / AKS — `BACKEND=k8s`)
```
Browser (Angular)
       │  JWT
       ▼
┌──────────────────────┐
│   .NET Backend API   │  port 8080
└──────────┬───────────┘
           │  X-Api-Key  →  http://HOST:30090  (NodePort, local)
           │               or sandbox-manager.sandboxes.svc:8090  (AKS internal)
           ▼
┌──────────────────────┐        ┌────────────────────────────────────────────┐
│   Sandbox Manager    │        │             Kubernetes cluster              │
│   Pod  :8090         │───────▶│  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│   NodePort :30090    │        │  │ Sandbox  │  │ Sandbox  │  │  ...     │ │
│   BACKEND=k8s        │        │  │  Pod+Svc │  │  Pod+Svc │  │          │ │
└──────────────────────┘        │  │  noVNC   │  │  noVNC   │  │          │ │
                                │  │  :30100  │  │  :30101  │  │          │ │
                                │  │  Bridge  │  │  Bridge  │  │          │ │
                                │  │  :31100  │  │  :31101  │  │          │ │
                                │  └──────────┘  └──────────┘  └──────────┘ │
                                └────────────────────────────────────────────┘
Browser → sandbox Bridge:  Authorization: Bearer <sandbox_token>  →  http://HOST:31100/...
```

### Security model

| Channel | Auth |
|---------|------|
| Browser → Backend API | JWT (user login) |
| Backend → Sandbox Manager | `X-Api-Key` header (static key from env) |
| Browser → Sandbox Bridge API | `Authorization: Bearer <sandbox_token>` (per-sandbox) |
| Browser → noVNC iframe | VNC password (per-sandbox, generated at creation) |

---

## Docker images

Two images are involved in the sandbox system. Both must be built before any sandbox can run.

### `devpilot-desktop` — the sandbox container

This is the image that runs **once per developer / per story**. Every time a user opens a sandbox in the UI, the manager creates a new container from this image.

**What's inside:**

| Component | Purpose |
|-----------|---------|
| Ubuntu 24.04 + XFCE | Full Linux desktop environment |
| Xvfb | Virtual screen (display `:0`) — no physical monitor needed |
| x11vnc | VNC server on the virtual screen |
| noVNC + nginx | Converts VNC to WebSocket → accessible as an iframe in the browser |
| .NET SDK 8 / 9 / 10 | For building .NET projects inside the sandbox |
| Node.js + npm | For building frontend projects |
| Git | To clone the repository at startup |
| Zed IDE | AI-powered IDE — receives prompts from the frontend and executes code |
| `devpilot-bridge.py` | Flask API (port 7100) — exposes Zed conversations and accepts prompt requests |

**Lifecycle:**

```
build once (10-20 min):
  docker build -t devpilot-desktop infra/sandbox/
                                           └── Dockerfile embedded in setup.sh

run on demand (one container per sandbox):
  manager.py → docker run devpilot-desktop
                     └── /start.sh
                           ├── Xvfb      → virtual screen
                           ├── x11vnc    → VNC server on :590x
                           ├── noVNC     → browser-accessible on :6100 (Docker) or :30100 (K8s)
                           ├── Zed IDE   → clones repo, opens project
                           └── bridge.py → REST API on :7100 (Docker) or :31100 (K8s)
```

Built by: `setup.sh` (Linux/macOS), `setup.ps1` (Windows), `setup-local.sh` / `setup-local.ps1` (K8s)

---

### `devpilot-manager` — the sandbox orchestrator

This is the image that runs **once on the host** (or as a single K8s Pod). It is the control plane: the .NET backend talks to it to create/destroy sandboxes.

**What's inside:**

| Component | Purpose |
|-----------|---------|
| Python 3.12-slim | Base runtime |
| Flask + flask-cors | HTTP API on port 8090 |
| Docker SDK (`docker`) | Creates/stops `devpilot-desktop` containers (Docker mode) |
| Kubernetes client (`kubernetes`) | Creates/deletes sandbox Pods and Services (K8s mode) |
| `manager.py` | Main API server — routes requests to Docker or K8s based on `BACKEND` env var |
| `k8s_utils.py` | Helpers for building Pod/Service manifests in K8s mode |
| `cleanup.py` | Standalone script (used by K8s CronJob) to delete stale sandbox Pods |

**What it does:**

```
.NET backend  →  POST /sandboxes          →  manager creates a devpilot-desktop container/Pod
              →  GET  /sandboxes          →  manager returns list of running sandboxes
              →  GET  /sandboxes/{id}     →  manager returns status of one sandbox
              →  DELETE /sandboxes/{id}   →  manager stops and removes the container/Pod
```

**Source:** `infra/sandbox/manager/`  
**Built by:** `setup-local.sh` / `setup-local.ps1` (K8s), or `docker-compose` (Windows Docker mode)

### Host package caches (npm / NuGet / pip)

Each `devpilot-desktop` sandbox uses **`/opt/npm-cache`**, **`/opt/nuget-cache`**, and **`/opt/pip-cache`** inside the container (see `setup.sh`). The manager bind-mounts host directories there and sets **`NPM_CONFIG_CACHE`**, **`NUGET_*`**, **`PIP_CACHE_DIR`** when mounts are present (`manager.py`).

| Tool | In-container paths | Env vars (set by manager when caches are mounted) |
|------|--------------------|---------------------------------------------------|
| npm | `/opt/npm-cache` | `NPM_CONFIG_CACHE=/opt/npm-cache` |
| NuGet | `/opt/nuget-cache/packages`, `.../http-cache`, `.../plugins-cache`, `.../scratch` | `NUGET_PACKAGES`, `NUGET_HTTP_CACHE_PATH`, `NUGET_PLUGINS_CACHE_PATH`, `NUGET_SCRATCH` ([NuGet cache layout](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders)) |
| pip | `/opt/pip-cache` | `PIP_CACHE_DIR=/opt/pip-cache` |

**Compose (host paths → manager):** root `docker-compose.yml` defaults to **`.sandbox-cache/{npm,nuget,pip}`** under the repo so **Docker Desktop** can bind-mount without adding `/opt` under *Settings → Resources → File Sharing*. A one-shot service **`sandbox-cache-init`** runs before **`sandbox-manager`** so those directories exist (avoids Docker failing to create the bind source and **`POST /sandboxes` returning 500**). Override in `.env` with **`DEVPILOT_NPM_CACHE_HOST`**, **`DEVPILOT_NUGET_CACHE_HOST`**, **`DEVPILOT_PIP_CACHE_HOST`** if you use global `/opt/...` instead.

If sandboxes are stuck in **`Created`** state from a failed start, remove them: `docker rm -f sandbox-<id>` (or `docker container prune`).

**Manager on the host** (Python not in Docker): if **`/opt/npm-cache`** (and siblings) exist on the host, they are mounted into sandboxes automatically.

**Linux VPS (full `setup.sh`, not `BUILD_ONLY`):** the script creates **`/opt/npm-cache`**, **`/opt/nuget-cache/...`**, **`/opt/pip-cache`** with **`chmod 1777`** on the host so the native manager can bind-mount them into sandboxes.

**Repo-local caches:** `deploy.sh` and **`infra/sandbox/setup.sh`** both ensure **`<repo>/.sandbox-cache/{npm,nuget,pip}`** exists (same paths as `docker-compose.yml`). Run **`bash deploy.sh`** before starting the manager, or run setup from the repo so those dirs exist.

**Manager overrides (optional):**

| Variable | Purpose |
|----------|---------|
| `SANDBOX_PACKAGE_CACHE_MOUNTS` | `false` / `0` / `off` — disable cache bind mounts into sandboxes. |
| `SANDBOX_NPM_CACHE_HOST` | Explicit Docker-host path for npm cache (overrides discovery). |
| `SANDBOX_NUGET_CACHE_HOST` | Explicit host path for NuGet tree. |
| `SANDBOX_PIP_CACHE_HOST` | Explicit host path for pip cache. |

If you use **`sudo docker compose`**, Docker may create **`.sandbox-cache`** as root; fix with `sudo chown -R "$(whoami)" .sandbox-cache` (or run compose without sudo).

**npm note:** cached artifacts live under **`_cacache`** inside the npm cache directory, not as a flat list of package names. Use `npm cache ls` inside a sandbox to see logical cache keys.

---

## Run modes

| Mode | `BACKEND=` | Manager port | Compatible with |
|------|-----------|--------------|-----------------|
| **Linux (systemd)** | `docker` only | `8090` | Docker Desktop / Docker Engine |
| **macOS (background process)** | `docker` only | `8090` | Docker Desktop for Mac |
| **Windows (Docker container)** | `docker` only | `8090` | Docker Desktop for Windows |
| **Kubernetes local** | `k8s` only | `30090` (NodePort) | Docker Desktop K8s, k3d, minikube |
| **AKS (production K8s)** | `k8s` only | `8090` (internal DNS) | Azure Kubernetes Service |

> **Linux, macOS and Windows setups only support `BACKEND=docker`.**
> They run the manager as a native process or Docker container that talks directly to the Docker daemon.
> To use Kubernetes you must use the dedicated K8s setup ([`k8s/`](k8s/)).

---

## Switching between Docker and Kubernetes

The `BACKEND` variable is read **only by the sandbox manager** (`infra/sandbox/manager/manager.py`).
It tells the manager which engine to use to create/destroy sandbox containers:

```
BACKEND=docker  → Docker SDK   — manager calls docker.containers.run() / stop()
BACKEND=k8s     → K8s client   — manager calls kubectl to create/delete Pods and Services
```

The .NET backend does **not** read `BACKEND` — it only needs to know the manager's URL (`VPS:GatewayUrl`), which differs between modes because the port changes.

The only **two things that change** when you switch:

| | Docker mode | Kubernetes mode |
|-|-------------|-----------------|
| `BACKEND` env var | `docker` (or unset) | `k8s` |
| `VPS:GatewayUrl` in backend | `http://localhost:8090` | `http://localhost:30090` (local) or `http://sandbox-manager.sandboxes.svc.cluster.local:8090` (AKS) |

### Switch to Docker mode

```bash
# infra/sandbox/k8s/.env  (or the .env used by your platform)
MANAGER_API_KEY=your_key
# BACKEND not set → defaults to docker
```

Backend config:
```json
"VPS": {
  "GatewayUrl":    "http://localhost:8090",
  "ManagerApiKey": "your_key",
  "PublicIp":      "localhost",
  "Enabled":       true
}
```

### Switch to Kubernetes mode

```bash
# infra/sandbox/k8s/.env
MANAGER_API_KEY=your_key
BACKEND=k8s
```

Then run:
```bash
bash infra/sandbox/k8s/setup-local.sh
```

Backend config:
```json
"VPS": {
  "GatewayUrl":    "http://localhost:30090",
  "ManagerApiKey": "your_key",
  "PublicIp":      "localhost",
  "Enabled":       true
}
```

> On AKS, `GatewayUrl` becomes `http://sandbox-manager.sandboxes.svc.cluster.local:8090`
> since the backend and manager are in the same cluster (internal DNS, no NodePort needed).

---

## Linux / macOS / Windows setup

### Linux VPS

```bash
# Prerequisites: Ubuntu 22.04/24.04, root access, ports 8090/6100-6200/7100-7200 open
sudo bash infra/sandbox/linux/setup.sh
```

### macOS (local dev)

```bash
# Prerequisites: Docker Desktop running
bash infra/sandbox/mac/setup.sh
```

### Windows (no WSL)

```powershell
# Prerequisites: Docker Desktop, Linux containers mode
.\infra\sandbox\windows\setup.ps1
```

### After setup — retrieve the API key

```bash
# Linux
sudo cat /opt/devpilot-sandbox/.env

# macOS
cat ~/.devpilot-sandbox/.env

# Windows — printed at the end of setup, also in infra/sandbox/windows/.env
```

### Configure the backend after setup

In `backend/src/API/appsettings.Development.json`:

```json
{
  "VPS": {
    "GatewayUrl":    "http://YOUR_HOST_IP:8090",
    "ManagerApiKey": "<MANAGER_API_KEY from .env>",
    "PublicIp":      "YOUR_HOST_IP_OR_localhost",
    "Enabled":       true
  }
}
```

> **Corporate proxy / Zscaler?** Place your `.crt` certificates in [`certs/`](certs/) **before** running any setup script. See [`certs/README.md`](certs/README.md).

---

## Kubernetes local testing / AKS deployment

All K8s setup is consolidated in [`infra/sandbox/k8s/`](k8s/). See [`infra/sandbox/k8s/README.md`](k8s/README.md) for:
- Local setup with Docker Desktop, k3d, or minikube
- AKS production deployment steps
- Manifests reference

Quick start:
```bash
cp infra/sandbox/k8s/.env.example infra/sandbox/k8s/.env
# Edit .env — set MANAGER_API_KEY
bash infra/sandbox/k8s/setup-local.sh
```

---

## AKS deployment

See [`infra/sandbox/k8s/README.md`](k8s/README.md) for the full AKS deployment guide including image build, secrets creation, and manifest application.

---

## Manager API reference

All endpoints require `X-Api-Key` header (except `/health`).

```bash
export API_KEY=<your_key>
export BASE=http://HOST_IP:8090   # or http://localhost:30090 for K8s
```

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (no auth) |
| `GET` | `/sandboxes` | List active sandboxes |
| `POST` | `/sandboxes` | Create a sandbox |
| `GET` | `/sandboxes/{id}` | Get sandbox status |
| `DELETE` | `/sandboxes/{id}` | Stop and remove sandbox |

### Create sandbox

```bash
curl -X POST $BASE/sandboxes \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "repo_url":    "https://github.com/org/repo.git",
    "repo_name":   "repo",
    "repo_branch": "main",
    "ai_config": {
      "provider": "openai",
      "api_key":  "sk-...",
      "model":    "gpt-4o"
    }
  }'
```

Response:
```json
{
  "id":            "a1b2c3d4",
  "port":          6100,
  "bridge_port":   7100,
  "url":           "http://HOST_IP:6100/vnc.html",
  "bridge_url":    "http://HOST_IP:7100",
  "status":        "starting",
  "sandbox_token": "<bearer token for bridge API>",
  "vnc_password":  "<password for noVNC>"
}
```

---

## Bridge API reference

Each sandbox exposes a bridge API on its `bridge_port`. All requests need:
```
Authorization: Bearer <sandbox_token>
```

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/all-conversations` | List Zed AI conversations |
| `GET` | `/latest-conversation` | Get the most recent conversation |
| `POST` | `/zed/send-prompt` | Send a prompt to Zed AI |
| `GET` | `/files` | List project files |
| `GET` | `/file?path=...` | Read a file |

```bash
export BRIDGE=http://HOST_IP:7100
export TOKEN=<sandbox_token>

curl $BRIDGE/latest-conversation -H "Authorization: Bearer $TOKEN"
curl -X POST $BRIDGE/zed/send-prompt \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain the architecture"}'
```

---

## Management commands

### Linux (systemd)

```bash
sudo systemctl status devpilot-sandbox
sudo systemctl restart devpilot-sandbox
journalctl -u devpilot-sandbox -f

# Helper script
cd /opt/devpilot-sandbox
sudo ./run.sh status | logs | start | stop | rebuild | cleanup
```

### macOS / Windows

```bash
# macOS
cd ~/.devpilot-sandbox && ./run.sh status | logs | stop | rebuild

# Windows
docker compose -f infra\sandbox\windows\docker-compose.yml up -d
docker logs -f devpilot-sandbox-manager
```

### K8s

```bash
kubectl get pods -n sandboxes
kubectl logs -f deployment/sandbox-manager -n sandboxes
kubectl rollout restart deployment/sandbox-manager -n sandboxes
```

---

## Troubleshooting

### 401 from Manager API
- Check `X-Api-Key` matches `MANAGER_API_KEY` in `.env` or K8s secret
- No trailing spaces or `%` at the end of the key

### 401 from Bridge API
- Verify the `sandbox_token` from the creation response is being used
- The token is per-sandbox and changes on every container restart

### VNC blank screen
```bash
docker exec <container_id> ps aux | grep x11vnc
docker exec <container_id> ps aux | grep Xvfb
docker exec <container_id> cat /tmp/sandbox-debug.log
```

### Zed not starting
```bash
docker exec <container_id> cat /tmp/zed-errors.log
docker exec -it <container_id> bash -c '
  source /tmp/dbus-env.sh
  export DISPLAY=:0 LIBGL_ALWAYS_SOFTWARE=1 HOME=/home/sandbox
  /home/sandbox/.local/bin/zed --foreground /home/sandbox/projects 2>&1
'
```

### Manager not responding on port 8090
```bash
curl http://localhost:8090/health
lsof -i :8090       # Docker/local
kubectl get pods -n sandboxes   # K8s
```

### Full reset (Docker)
```bash
docker rm -f $(docker ps -aq --filter "name=sandbox-") 2>/dev/null
docker rmi devpilot-desktop 2>/dev/null
docker volume prune -f
```

### Full reset (K8s)
```bash
kubectl delete namespace sandboxes
bash infra/sandbox/k8s/setup-local.sh
```
