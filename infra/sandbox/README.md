# DevPilot Sandbox

Multi-container sandbox system that creates isolated desktop environments on demand.
Each sandbox is an independent container with its own XFCE desktop, Zed IDE, and bridge API.

---

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
┌──────────────────────┐        ┌────────────────────────────────────────────┐
│   Sandbox Manager    │        │             Host (VPS / K8s node)          │
│   Flask  port 8090   │───────▶│  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│   (Python)           │        │  │ Sandbox  │  │ Sandbox  │  │  ...     │ │
└──────────────────────┘        │  │  noVNC   │  │  noVNC   │  │          │ │
                                │  │  :6100   │  │  :6101   │  │          │ │
                                │  │  Bridge  │  │  Bridge  │  │          │ │
                                │  │  :7100   │  │  :7101   │  │          │ │
                                │  └──────────┘  └──────────┘  └──────────┘ │
                                └────────────────────────────────────────────┘

Browser also talks directly to each sandbox's Bridge API with a per-sandbox Bearer token:
  Authorization: Bearer <sandbox_token>  →  http://HOST_IP:7100/...
```

### Security model

| Channel | Auth |
|---------|------|
| Browser → Backend API | JWT (user login) |
| Backend → Sandbox Manager | `X-Api-Key` header (static key from env) |
| Browser → Sandbox Bridge API | `Authorization: Bearer <sandbox_token>` (per-sandbox) |
| Browser → noVNC iframe | VNC password (per-sandbox, generated at creation) |

---

## Run modes

| Mode | Use case | Docs |
|------|----------|------|
| **Linux (systemd)** | Production VPS | [linux/](linux/) |
| **macOS (background process)** | Local dev on Mac | [mac/](mac/) |
| **Windows (Docker container)** | Local dev on Windows | [windows/](windows/) |
| **Kubernetes local** | Test K8s setup locally | [k8s/](k8s/) |
| **AKS (production K8s)** | Cloud deployment | [below](#aks-deployment) |

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

## Kubernetes local testing

For local K8s testing with Docker Desktop, k3d, or minikube.

### Prerequisites

**Option A — Docker Desktop** (easiest)
> Docker Desktop → Settings → Kubernetes → Enable Kubernetes

**Option B — k3d** (recommended — fast start/stop)
```bash
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash

k3d cluster create devpilot \
  --port "30090:30090@loadbalancer" \
  --port "30100-30110:30100-30110@loadbalancer" \
  --port "31100-31110:31100-31110@loadbalancer"
```

**Option C — minikube**
```bash
minikube start --driver=docker
minikube tunnel &
```

### Run setup

```bash
# Create infra/sandbox/k8s/.env from the template first
cp infra/sandbox/k8s/.env.example infra/sandbox/k8s/.env
# Edit .env — set MANAGER_API_KEY to your fixed key

bash infra/sandbox/k8s/setup-local.sh
# Force rebuild: bash infra/sandbox/k8s/setup-local.sh --rebuild
```

The script:
1. Loads `MANAGER_API_KEY` from `infra/sandbox/k8s/.env` (or env var)
2. Builds `devpilot-desktop` and `devpilot-manager` images and loads them into the cluster
3. Applies all K8s manifests (namespace, RBAC, secret, deployment, service)
4. Waits for the manager pod to be ready
5. Prints the `appsettings.json` snippet to copy into the backend

### Configure backend for K8s local

```json
{
  "VPS": {
    "GatewayUrl":    "http://localhost:30090",
    "ManagerApiKey": "<same MANAGER_API_KEY>",
    "PublicIp":      "localhost",
    "Enabled":       true
  }
}
```

### Verify

```bash
kubectl get pods -n sandboxes
kubectl logs -f deployment/sandbox-manager -n sandboxes
curl http://localhost:30090/health
```

### Ports (K8s NodePort)

| Service | NodePort |
|---------|----------|
| Manager API | 30090 |
| noVNC sandbox #1 | 30100 |
| noVNC sandbox #2 | 30101 |
| Bridge API sandbox #1 | 31100 |
| Bridge API sandbox #2 | 31101 |

### Teardown

```bash
kubectl delete namespace sandboxes
# k3d: k3d cluster delete devpilot
```

---

## AKS deployment

### What's already ready

| Component | Status | File |
|-----------|--------|------|
| Namespace | Ready | `infra/k8s/manifests/namespace.yaml` |
| RBAC (ServiceAccount + RoleBinding) | Ready | `infra/k8s/manifests/rbac.yaml` |
| Manager Deployment + NodePort Service | Ready | `infra/k8s/manifests/manager-deployment.yaml` |
| Manager Secret template | Ready | `infra/k8s/manifests/manager-secret.yaml.template` |
| Cleanup CronJob | Ready | `infra/k8s/manifests/cleanup-cronjob.yaml` |
| Manager Dockerfile | Ready | `infra/sandbox/manager/Dockerfile` |

### What you need to do before deploying to AKS

1. **Push the manager image to a registry (GHCR or ACR)**

```bash
docker build -t ghcr.io/YOUR_ORG/devpilot-manager:latest infra/sandbox/manager/
docker push ghcr.io/YOUR_ORG/devpilot-manager:latest

docker build -t ghcr.io/YOUR_ORG/devpilot-desktop:latest infra/sandbox/
docker push ghcr.io/YOUR_ORG/devpilot-desktop:latest
```

2. **Update image references** in `infra/k8s/manifests/manager-deployment.yaml`:
```yaml
image: ghcr.io/YOUR_ORG/devpilot-manager:latest
```
And in `infra/k8s/manifests/manager-secret.yaml.template`:
```yaml
SANDBOX_IMAGE: "ghcr.io/YOUR_ORG/devpilot-desktop:latest"
```

3. **Create the K8s Secret** (never commit the secret file):

```bash
cp infra/k8s/manifests/manager-secret.yaml.template infra/k8s/manifests/manager-secret.yaml
# Edit manager-secret.yaml with real values, then:
kubectl apply -f infra/k8s/manifests/manager-secret.yaml
```

Or directly via `kubectl`:
```bash
kubectl create secret generic manager-secrets -n sandboxes \
  --from-literal=MANAGER_API_KEY="your_key" \
  --from-literal=HOST_IP="your_aks_node_ip" \
  --from-literal=BACKEND="k8s" \
  --from-literal=SANDBOX_IMAGE="ghcr.io/YOUR_ORG/devpilot-desktop:latest"
```

4. **Apply all manifests**:

```bash
kubectl apply -f infra/k8s/manifests/namespace.yaml
kubectl apply -f infra/k8s/manifests/rbac.yaml
kubectl apply -f infra/k8s/manifests/manager-deployment.yaml
kubectl apply -f infra/k8s/manifests/cleanup-cronjob.yaml
```

5. **Configure the backend** to point at the manager's internal K8s service:

```
VPS__GatewayUrl    = http://sandbox-manager.sandboxes.svc.cluster.local:8090
VPS__ManagerApiKey = <same key as MANAGER_API_KEY in the secret>
VPS__PublicIp      = <AKS node public IP or LoadBalancer IP>
```

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
