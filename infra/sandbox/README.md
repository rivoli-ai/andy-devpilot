# DevPilot Sandbox

Multi-container sandbox system that creates isolated desktop environments on demand.
Each sandbox is an independent Docker container with its own XFCE desktop, Zed IDE, and bridge API.

## Architecture

```
Browser (Angular)
       │
       │  JWT  (user auth)
       ▼
┌──────────────────────┐
│   .NET Backend API   │  ← validates JWT, stores ownership
│   port 8080          │  ← uses X-Api-Key to talk to manager
└──────────┬───────────┘
           │  X-Api-Key
           ▼
┌──────────────────────┐        ┌──────────────────────────────────────────┐
│   Sandbox Manager    │        │                  VPS                     │
│   Flask  port 8090   │ ──────▶│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│   (Python)           │        │  │ Sandbox  │  │ Sandbox  │  │  ...   │ │
└──────────────────────┘        │  │  noVNC   │  │  noVNC   │  │        │ │
                                │  │  :6100   │  │  :6101   │  │        │ │
                                │  │  Bridge  │  │  Bridge  │  │        │ │
                                │  │  :7100   │  │  :7101   │  │        │ │
                                │  └──────────┘  └──────────┘  └────────┘ │
                                └──────────────────────────────────────────┘

Browser also talks directly to each sandbox's Bridge API with a per-sandbox Bearer token:
  Authorization: Bearer <sandbox_token>  →  http://VPS_IP:7100/...
```

### Security model

| Channel | Auth |
|---------|------|
| Browser → Backend API | JWT (user login) |
| Backend → Sandbox Manager | `X-Api-Key` header (static key from `.env`) |
| Browser → Sandbox Bridge API | `Authorization: Bearer <sandbox_token>` (per-sandbox, generated at creation) |
| Browser → noVNC iframe | VNC password (per-sandbox, generated at creation) |

---

## Platform Setup

Choose your platform — each has a dedicated folder with a setup script and README:

| Platform | Folder | Command |
|----------|--------|---------|
| 🐧 Linux (VPS) | [`linux/`](linux/) | `sudo bash infra/sandbox/linux/setup.sh` |
| 🍎 macOS (local dev) | [`mac/`](mac/) | `bash infra/sandbox/mac/setup.sh` |
| 🪟 Windows (Docker Desktop) | [`windows/`](windows/) | `.\infra\sandbox\windows\setup.ps1` |

### After setup — configure the backend

In `backend/src/API/appsettings.json`:

```json
{
  "VPS": {
    "GatewayUrl": "http://YOUR_VPS_IP:8090",
    "ManagerApiKey": "<key printed at end of setup>",
    "PublicIp": "YOUR_VPS_IP_OR_localhost",
    "Enabled": true
  }
}
```

> **Corporate proxy / Zscaler?** Place your `.crt` certificates in [`certs/`](certs/) before running any setup script. See [`certs/README.md`](certs/README.md).

---

## Manager API

All requests require the `X-Api-Key` header. The key is stored in `/opt/devpilot-sandbox/.env`.

```bash
export API_KEY=$(sudo grep MANAGER_API_KEY /opt/devpilot-sandbox/.env | cut -d= -f2)
export BASE=http://YOUR_VPS_IP:8090
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (no auth required) |
| `GET` | `/sandboxes` | List all active sandboxes |
| `POST` | `/sandboxes` | Create a new sandbox |
| `GET` | `/sandboxes/{id}` | Get sandbox status |
| `DELETE` | `/sandboxes/{id}` | Stop and remove a sandbox |

### Create sandbox

```bash
curl -X POST $BASE/sandboxes \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "repo_url": "https://github.com/org/repo.git",
    "repo_name": "repo",
    "repo_branch": "main",
    "ai_config": {
      "provider": "openai",
      "api_key": "sk-...",
      "model": "gpt-4o"
    }
  }'
```

Response:
```json
{
  "id": "a1b2c3d4",
  "port": 6100,
  "bridge_port": 7100,
  "url": "http://YOUR_VPS_IP:6100/vnc.html",
  "bridge_url": "http://YOUR_VPS_IP:7100",
  "status": "starting",
  "sandbox_token": "<random bearer token>",
  "vnc_password": "<random vnc password>"
}
```

### List sandboxes

```bash
curl $BASE/sandboxes -H "X-Api-Key: $API_KEY"
```

### Delete sandbox

```bash
curl -X DELETE $BASE/sandboxes/a1b2c3d4 -H "X-Api-Key: $API_KEY"
```

---

## Sandbox Bridge API

Each sandbox exposes a bridge API on its bridge port (7100–7200).
Requests must include the per-sandbox bearer token returned at creation time.

```bash
export BRIDGE=http://YOUR_VPS_IP:7100
export TOKEN=<sandbox_token>
```

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/all-conversations` | List Zed AI conversations |
| `GET` | `/latest-conversation` | Get the most recent conversation |
| `POST` | `/zed/send-prompt` | Send a prompt to Zed AI |
| `GET` | `/files` | List files in the project |
| `GET` | `/file?path=...` | Read a file |

```bash
# Get latest AI conversation
curl $BRIDGE/latest-conversation \
  -H "Authorization: Bearer $TOKEN"

# Send a prompt to Zed
curl -X POST $BRIDGE/zed/send-prompt \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain the architecture of this project"}'
```

---

## Ports

| Range | Service |
|-------|---------|
| `8090` | Sandbox Manager API |
| `6100–6200` | noVNC (web remote desktop) per sandbox |
| `7100–7200` | Bridge API per sandbox |

---

## Manager service management

```bash
# Status
sudo systemctl status devpilot-sandbox

# Logs (live)
journalctl -u devpilot-sandbox -f

# Last 50 lines
journalctl -u devpilot-sandbox -n 50 --no-pager

# Restart
sudo systemctl restart devpilot-sandbox
```

Or use the helper script installed at `/opt/devpilot-sandbox/run.sh`:

```bash
cd /opt/devpilot-sandbox
./run.sh status
./run.sh logs
./run.sh start
./run.sh stop
./run.sh rebuild    # Rebuild desktop Docker image
./run.sh cleanup    # Remove all sandbox containers
```

---

## Container management

```bash
# List running sandbox containers
docker ps --filter "name=sandbox-"

# View logs for a specific container
docker logs <container_id>

# Open a shell inside a container
docker exec -it <container_id> bash

# Check environment variables in container
docker exec <container_id> env | grep -E "REPO|DEVPILOT|SANDBOX"

# Stop all sandbox containers
docker ps -q --filter "name=sandbox-" | xargs -r docker stop

# Remove all sandbox containers
docker ps -aq --filter "name=sandbox-" | xargs -r docker rm -f
```

---

## Full reset

```bash
# Stop service
sudo systemctl stop devpilot-sandbox

# Remove all containers and image
docker rm -f $(docker ps -aq --filter "name=sandbox-") 2>/dev/null
docker rmi devpilot-desktop 2>/dev/null
docker volume prune -f

# Redeploy
sudo bash setup.sh
```

---

## Troubleshooting

### Manager not responding on port 8090

```bash
sudo systemctl status devpilot-sandbox
curl http://localhost:8090/health
lsof -i :8090
```

### 401 Unauthorized from Bridge API

- Verify the `sandbox_token` in the request matches the one returned at creation
- The token is per-sandbox and is regenerated every time a new container is created

### 401 Unauthorized from Manager API

- Check `X-Api-Key` matches the value in `/opt/devpilot-sandbox/.env`
- Key is regenerated each time `setup.sh` runs — update `appsettings.json` accordingly

### Zed not starting inside container

```bash
docker exec -it <container_id> bash -c '
  source /tmp/dbus-env.sh
  export DISPLAY=:0 LIBGL_ALWAYS_SOFTWARE=1 HOME=/home/sandbox
  /home/sandbox/.local/bin/zed --foreground /home/sandbox/projects 2>&1
'

# Check startup logs
docker exec <container_id> cat /tmp/sandbox-debug.log
docker exec <container_id> cat /tmp/zed-errors.log
```

### VNC blank screen

```bash
# Check x11vnc is running
docker exec <container_id> ps aux | grep x11vnc

# Check Xvfb is running
docker exec <container_id> ps aux | grep Xvfb
```
