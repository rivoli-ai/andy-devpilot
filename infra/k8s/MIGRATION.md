# DevPilot Sandbox — Kubernetes Migration

## Table of contents

1. [Why K8s](#why-k8s)
2. [Architecture comparison](#architecture-comparison)
3. [Port strategy](#port-strategy)
4. [Local testing](#local-testing)
5. [File structure](#file-structure)
6. [Migration phases](#migration-phases)
7. [BACKEND flag (zero-risk rollout)](#backend-flag)
8. [K8s manifests explained](#k8s-manifests-explained)
9. [Manager rewrite summary](#manager-rewrite-summary)
10. [Backend .NET changes](#backend-net-changes)
11. [Production deployment (k3s VPS)](#production-deployment)
12. [Rollback procedure](#rollback-procedure)
13. [Configuration reference](#configuration-reference)

---

## Why K8s

| | Docker direct (current) | Kubernetes |
|---|---|---|
| Resource limits (CPU/RAM) | Manual `--memory` flag | `requests` / `limits` per Pod |
| Auto-restart on crash | No | `restartPolicy` |
| Multi-node scaling | Not possible | Native |
| Rolling image updates | Restart required | Zero-downtime rollout |
| State | In-memory dict (lost on restart) | K8s API is source of truth |
| Cleanup | Background thread | CronJob |
| Observability | `docker logs` | `kubectl logs`, Prometheus, Grafana |

---

## Architecture comparison

### Current (Docker direct)

```
Browser
  |-- JWT --> .NET Backend :8080
                |-- X-Api-Key --> manager.py :8090 (systemd on VPS)
                                    |-- docker.from_env()
                                         |-- container sandbox-xxxx
                                              |-- noVNC   :6100
                                              |-- Bridge  :7100
Browser
  |-- Bearer token --> sandbox Bridge :7100
  |-- iframe --------> noVNC          :6100
```

### After K8s migration

```
Browser
  |-- JWT --> .NET Backend :8080
                |-- X-Api-Key --> manager.py :30090 (K8s Deployment)
                                    |-- kubernetes client
                                         |-- Pod sandbox-xxxx  (namespace: sandboxes)
                                         |-- Service NodePort
                                              |-- noVNC   :30100
                                              |-- Bridge  :31100
Browser
  |-- Bearer token --> sandbox Bridge :31100
  |-- iframe --------> noVNC          :30100
```

---

## Port strategy

### NodePort ranges

| Usage | Current port | K8s NodePort | Count |
|-------|-------------|--------------|-------|
| Manager API | 8090 | 30090 | 1 (fixed) |
| noVNC per sandbox | 6100-6200 | 30100-30200 | up to 100 |
| Bridge API per sandbox | 7100-7200 | 31100-31200 | up to 100 |

NodePorts must be in the range `30000-32767` (K8s default).
The mapping is 1-to-1: sandbox index `i` → noVNC `30100+i`, bridge `31100+i`.

### Why NodePort (not Ingress)

noVNC uses **WebSockets** loaded in an `<iframe>` directly from the browser.
An Ingress with WebSocket support works but adds complexity (nginx-ingress annotations,
SSL termination, wildcard DNS). NodePort is simpler and works out of the box.

**Ingress alternative** (for production with a real domain):
- Each sandbox gets a subdomain: `a1b2c3d4.sandboxes.yourdomain.com`
- Requires wildcard DNS `*.sandboxes.yourdomain.com`
- Requires nginx-ingress with websocket annotations
- See [ingress variant](#ingress-variant) section

---

## Local testing

Three options to run K8s locally without a VPS:

### Option A — Docker Desktop (Windows/macOS) — easiest

1. Open Docker Desktop → Settings → Kubernetes → Enable Kubernetes
2. Wait for the green "Kubernetes running" status
3. Run the local setup:

```bash
bash infra/sandbox/k8s/setup-local.sh
```

### Option B — k3d (k3s in Docker) — recommended for dev

k3d runs a full k3s cluster inside Docker containers. Fastest to spin up/down.

```bash
# Install k3d
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash

# Create a cluster with NodePort range exposed
k3d cluster create devpilot \
  --port "30090:30090@loadbalancer" \
  --port "30100-30200:30100-30200@loadbalancer" \
  --port "31100-31200:31100-31200@loadbalancer"

# Run setup
bash infra/sandbox/k8s/setup-local.sh
```

### Option C — minikube

```bash
# Install minikube (https://minikube.sigs.k8s.io/docs/start/)
minikube start --driver=docker

# Expose NodePorts (minikube uses a VM — need tunnel)
minikube tunnel &

# Run setup
bash infra/sandbox/k8s/setup-local.sh
```

---

## File structure

```
infra/
├── k8s/
│   ├── MIGRATION.md              <- this file
│   ├── setup-local.sh            <- local cluster setup (k3d / Docker Desktop)
│   └── manifests/
│       ├── namespace.yaml
│       ├── rbac.yaml
│       ├── manager-deployment.yaml
│       ├── manager-service.yaml
│       └── manager-secret.yaml.template
│
└── sandbox/
    ├── setup.sh                  <- Linux/macOS (unchanged, Docker mode)
    ├── manager/                  <- new: K8s-aware manager
    │   ├── manager.py            <- rewritten with BACKEND flag
    │   ├── k8s_utils.py          <- K8s manifest builders
    │   ├── cleanup.py            <- K8s CronJob cleanup script
    │   ├── Dockerfile
    │   └── requirements.txt
    ├── linux/
    ├── mac/
    └── windows/
```

---

## Migration phases

### Phase 1 — Local validation (you are here)
- [x] Migration plan documented
- [ ] K8s manifests created
- [ ] manager.py rewritten with `BACKEND=k8s` support
- [ ] Local test with k3d or Docker Desktop K8s
- [ ] Validate: create sandbox, VNC works, bridge works, delete sandbox

### Phase 2 — Staging on VPS
- [ ] Install k3s on VPS: `curl -sfL https://get.k3s.io | sh -`
- [ ] Push `devpilot-desktop` image to registry (GHCR or private)
- [ ] Push `devpilot-manager` image to registry
- [ ] Apply K8s manifests
- [ ] Switch backend `BACKEND=k8s` on VPS
- [ ] Update `appsettings.json` with new NodePort (30090)
- [ ] Smoke test

### Phase 3 — Production cutover
- [ ] Remove old systemd service: `systemctl disable devpilot-sandbox`
- [ ] Set `BACKEND=k8s` as default (remove `BACKEND=docker` code path)
- [ ] Set up monitoring (optional: Prometheus + Grafana via Helm)

---

## BACKEND flag

The manager supports two backends selected by the `BACKEND` environment variable:

```bash
BACKEND=docker   # (default) current behaviour — Docker SDK
BACKEND=k8s      # new K8s behaviour — kubernetes Python client
```

This allows running both modes side-by-side during migration. The flag can be set:
- In `appsettings` / environment on the VPS
- In the K8s Deployment manifest
- In `windows/.env` for local Windows dev

**No changes are needed in the .NET backend or Angular frontend** — the manager's
API response shape is identical in both modes (same JSON fields, same port logic).

---

## K8s manifests explained

### namespace.yaml

Creates the `sandboxes` namespace. All sandbox Pods and Services live here.
The manager Deployment also lives here.

### rbac.yaml

Gives the `sandbox-manager` ServiceAccount permission to:
- `create`, `delete`, `get`, `list`, `watch` Pods in `sandboxes`
- `create`, `delete`, `get`, `list`, `watch` Services in `sandboxes`

The manager Pod runs with this ServiceAccount so `load_incluster_config()` works.

### manager-deployment.yaml

- 1 replica of the manager (Flask app)
- Mounts the `manager-secrets` K8s Secret as env vars
- Uses the `sandbox-manager` ServiceAccount
- Exposed via a fixed NodePort `30090`

### manager-secret.yaml.template

Template for the K8s Secret holding `MANAGER_API_KEY` and `HOST_IP`.
Copy and fill in values, then `kubectl apply -f manager-secret.yaml`.
**Never commit the filled-in file.**

---

## Manager rewrite summary

### What changes

| Component | Before | After |
|-----------|--------|-------|
| Import | `import docker` | `from kubernetes import client, config` |
| Init | `docker.from_env()` | `config.load_incluster_config()` |
| Create | `client.containers.run(...)` | `create_namespaced_pod()` + `create_namespaced_service()` |
| Delete | `container.stop(); container.remove()` | `delete_namespaced_pod()` + `delete_namespaced_service()` |
| List | in-memory `sandboxes` dict | `list_namespaced_pod(label_selector=...)` |
| State | in-memory dict | K8s API (labels) + dict for tokens/passwords |
| Cleanup | background thread | K8s CronJob |
| Port alloc | `used_ports` set | scan existing Services for used NodePorts |

### What stays the same

- Flask HTTP API (same routes, same request/response JSON)
- `require_api_key()` auth
- `MANAGER_API_KEY` env var
- `sandbox_token` and `vnc_password` generation
- Auto-cleanup at 2 hours

---

## Backend .NET changes

**Minimal.** Only `appsettings.json` changes:

```json
// Before (Docker direct, default port 8090)
"VPS": {
  "GatewayUrl": "http://VPS_IP:8090",
  "PublicIp":   "VPS_IP"
}

// After (K8s, manager on NodePort 30090)
"VPS": {
  "GatewayUrl": "http://VPS_IP:30090",
  "PublicIp":   "VPS_IP"
}
```

`SandboxService.cs` code does not change. The manager returns the same JSON shape
with `port` (NodePort 30100+) and `bridge_port` (NodePort 31100+) instead of
the old Docker-mapped ports.

---

## Production deployment (k3s VPS)

```bash
# 1. Install k3s
curl -sfL https://get.k3s.io | sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# 2. Build and push images
docker build -t ghcr.io/YOUR_ORG/devpilot-desktop:latest \
  -f infra/sandbox/desktop/Dockerfile infra/sandbox/desktop/
docker push ghcr.io/YOUR_ORG/devpilot-desktop:latest

docker build -t ghcr.io/YOUR_ORG/devpilot-manager:latest \
  infra/sandbox/manager/
docker push ghcr.io/YOUR_ORG/devpilot-manager:latest

# 3. Create image pull secret
kubectl create secret docker-registry ghcr-secret \
  --docker-server=ghcr.io \
  --docker-username=YOUR_GITHUB_USER \
  --docker-password=YOUR_PAT \
  -n sandboxes

# 4. Create manager secret
cp infra/k8s/manifests/manager-secret.yaml.template /tmp/manager-secret.yaml
# edit /tmp/manager-secret.yaml and fill in values
kubectl apply -f /tmp/manager-secret.yaml

# 5. Apply all manifests
kubectl apply -f infra/k8s/manifests/

# 6. Verify
kubectl get pods -n sandboxes
kubectl logs -f deployment/sandbox-manager -n sandboxes

# 7. Update backend config
# Set VPS:GatewayUrl to http://VPS_IP:30090

# 8. Open firewall
ufw allow 30090/tcp   # manager
ufw allow 30100:30200/tcp  # noVNC
ufw allow 31100:31200/tcp  # bridge
```

---

## Rollback procedure

```bash
# Instant rollback to Docker direct
kubectl scale deployment/sandbox-manager --replicas=0 -n sandboxes

# Start old systemd service
systemctl start devpilot-sandbox

# Revert appsettings.json GatewayUrl to port 8090
```

---

## Configuration reference

### Manager environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BACKEND` | No | `docker` (default) or `k8s` |
| `MANAGER_API_KEY` | Yes | Random secret key |
| `HOST_IP` | Yes | VPS public IP (used in sandbox URLs) |
| `K8S_NAMESPACE` | No | K8s namespace for sandboxes (default: `sandboxes`) |
| `NOVNC_NODEPORT_START` | No | First noVNC NodePort (default: `30100`) |
| `BRIDGE_NODEPORT_START` | No | First Bridge NodePort (default: `31100`) |
| `SANDBOX_IMAGE` | No | Desktop image name (default: `ghcr.io/YOUR_ORG/devpilot-desktop:latest`) |
| `SANDBOX_CPU_REQUEST` | No | CPU request per sandbox (default: `250m`) |
| `SANDBOX_CPU_LIMIT` | No | CPU limit per sandbox (default: `2000m`) |
| `SANDBOX_MEM_REQUEST` | No | Memory request per sandbox (default: `512Mi`) |
| `SANDBOX_MEM_LIMIT` | No | Memory limit per sandbox (default: `2Gi`) |
| `IMAGE_PULL_SECRET` | No | K8s secret name for private registry (default: `ghcr-secret`) |

### appsettings.json

```json
"VPS": {
  "GatewayUrl":    "http://VPS_IP:30090",
  "ManagerApiKey": "same key as MANAGER_API_KEY",
  "PublicIp":      "VPS_IP",
  "Enabled":       true
}
```
