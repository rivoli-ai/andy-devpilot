# DevPilot — Kubernetes

Everything needed to run DevPilot sandboxes on Kubernetes — local testing and AKS production.

```
infra/sandbox/
├── linux/         ← Linux VPS setup (systemd)
├── mac/           ← macOS setup (background process)
├── windows/       ← Windows setup (Docker container)
└── k8s/           ← Kubernetes setup (local + AKS)  ← YOU ARE HERE
    ├── setup-local.sh          ← local K8s setup for macOS / Linux
    ├── setup-local.ps1         ← local K8s setup for Windows (PowerShell)
    ├── .env.example            ← copy to .env, set MANAGER_API_KEY + BACKEND=k8s
    ├── .gitignore              ← ignores .env and secret YAML files
    └── manifests/
    ├── namespace.yaml          ← sandboxes namespace
    ├── rbac.yaml               ← ServiceAccount + RoleBinding for manager
    ├── manager-deployment.yaml ← sandbox manager Deployment + NodePort Service (:30090)
    ├── manager-secret.yaml.template  ← copy to manager-secret.yaml, fill in values
    ├── backend-deployment.yaml ← .NET backend Deployment + ClusterIP Service
    ├── backend-secret.yaml.template  ← copy to backend-secret.yaml, fill in values
    └── cleanup-cronjob.yaml    ← CronJob to remove stale sandbox Pods automatically
```

> `.env`, `manager-secret.yaml`, and `backend-secret.yaml` are gitignored — never commit them.

---

## Local setup (Docker Desktop / k3d / minikube)

### 1. Start a local K8s cluster

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
minikube tunnel &   # in a separate terminal
```

### 2. Configure your API key

```bash
cp infra/sandbox/k8s/.env.example infra/sandbox/k8s/.env
# Edit .env — set MANAGER_API_KEY to your fixed key (BACKEND=k8s is already set)
```

### 3. Run setup

**macOS / Linux:**
```bash
bash infra/sandbox/k8s/setup-local.sh

# Force full image rebuild:
bash infra/sandbox/k8s/setup-local.sh --rebuild
```

**Windows (PowerShell):**
```powershell
.\infra\sandbox\k8s\setup-local.ps1

# Force full image rebuild:
.\infra\sandbox\k8s\setup-local.ps1 -Rebuild

# If you get a script execution error:
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

The script:
1. Loads `MANAGER_API_KEY` from `infra/sandbox/k8s/.env` (or env var)
2. Builds `devpilot-desktop` and `devpilot-manager` images and loads them into the cluster
3. Applies all manifests (namespace, RBAC, secret, deployment, service)
4. Waits for the manager pod to be ready
5. Prints the backend config snippet to copy

### 4. Configure the .NET backend

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

### 5. Verify

```bash
kubectl get pods -n sandboxes
kubectl logs -f deployment/sandbox-manager -n sandboxes
curl http://localhost:30090/health
# {"status":"ok","version":"3.0.0","backend":"k8s","active_sandboxes":0}
```

### Teardown

```bash
kubectl delete namespace sandboxes
# k3d:      k3d cluster delete devpilot
# minikube: minikube stop
```

---

## Ports (NodePort — local K8s)

| Service | NodePort | Used by |
|---------|----------|---------|
| Manager API | 30090 | .NET backend → manager |
| noVNC sandbox #1 | 30100 | browser iframe |
| noVNC sandbox #2 | 30101 | browser iframe |
| Bridge API sandbox #1 | 31100 | browser → bridge |
| Bridge API sandbox #2 | 31101 | browser → bridge |

---

## AKS production deployment

### What's ready

| File | Purpose |
|------|---------|
| `manifests/namespace.yaml` | `sandboxes` namespace |
| `manifests/rbac.yaml` | ServiceAccount + RoleBinding for manager |
| `manifests/manager-deployment.yaml` | Manager Deployment + NodePort Service |
| `manifests/manager-secret.yaml.template` | Manager secrets template |
| `manifests/backend-deployment.yaml` | Backend Deployment + ClusterIP Service |
| `manifests/backend-secret.yaml.template` | Backend secrets template |
| `manifests/cleanup-cronjob.yaml` | Auto-cleanup of stale sandbox Pods |

### Steps

1. **Build and push images** to GHCR or ACR:

```bash
# From repository root (required so certs/ and paths in Dockerfiles resolve).

# Manager
docker build -t ghcr.io/YOUR_ORG/devpilot-manager:latest -f infra/sandbox/manager/Dockerfile .
docker push ghcr.io/YOUR_ORG/devpilot-manager:latest

# Desktop (sandbox container)
docker build -t ghcr.io/YOUR_ORG/devpilot-desktop:latest infra/sandbox/
docker push ghcr.io/YOUR_ORG/devpilot-desktop:latest

# Backend
docker build -t ghcr.io/YOUR_ORG/devpilot-backend:latest -f backend/Dockerfile .
docker push ghcr.io/YOUR_ORG/devpilot-backend:latest
```

2. **Update image references** in `manager-deployment.yaml` and `backend-deployment.yaml`:
```yaml
image: ghcr.io/YOUR_ORG/devpilot-manager:latest
```

3. **Create secrets** (never commit the secret files):

```bash
# Manager secret
cp manifests/manager-secret.yaml.template manifests/manager-secret.yaml
# Fill in values, then:
kubectl apply -f manifests/manager-secret.yaml

# Backend secret
cp manifests/backend-secret.yaml.template manifests/backend-secret.yaml
# Fill in values, then:
kubectl apply -f manifests/backend-secret.yaml
```

Or directly via `kubectl` (no file needed):
```bash
kubectl create secret generic manager-secrets -n sandboxes \
  --from-literal=MANAGER_API_KEY="your_key" \
  --from-literal=HOST_IP="your_aks_node_ip" \
  --from-literal=BACKEND="k8s" \
  --from-literal=SANDBOX_IMAGE="ghcr.io/YOUR_ORG/devpilot-desktop:latest"

kubectl create secret generic backend-secrets -n devpilot \
  --from-literal=ConnectionStrings__DefaultConnection="Host=...;Username=...;Password=...;Database=analyzer" \
  --from-literal=JWT__SecretKey="YOUR_STRONG_SECRET" \
  --from-literal=AI__ApiKey="YOUR_AI_KEY" \
  --from-literal=VPS__GatewayUrl="http://sandbox-manager.sandboxes.svc.cluster.local:8090" \
  --from-literal=VPS__ManagerApiKey="your_key" \
  --from-literal=VPS__PublicIp="YOUR_NODE_PUBLIC_IP"
```

4. **Apply all manifests**:

```bash
kubectl apply -f manifests/namespace.yaml
kubectl apply -f manifests/rbac.yaml
kubectl apply -f manifests/manager-deployment.yaml
kubectl apply -f manifests/cleanup-cronjob.yaml
kubectl create namespace devpilot --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f manifests/backend-deployment.yaml
```

5. **Backend config** (via K8s Secret env vars — no `appsettings` file needed):

```
VPS__GatewayUrl    = http://sandbox-manager.sandboxes.svc.cluster.local:8090
VPS__ManagerApiKey = <same key as manager secret>
VPS__PublicIp      = <AKS node public IP or LoadBalancer IP>
```

> On AKS the backend and manager talk over internal K8s DNS — no NodePort needed for manager.

---

## Manifests reference

| File | What it creates |
|------|----------------|
| `namespace.yaml` | `sandboxes` K8s namespace |
| `rbac.yaml` | `sandbox-manager` ServiceAccount + Role (create/delete Pods, Services) |
| `manager-deployment.yaml` | Manager Deployment (1 replica) + NodePort Service on `:30090` |
| `manager-secret.yaml.template` | `MANAGER_API_KEY`, `HOST_IP`, `BACKEND`, `SANDBOX_IMAGE` |
| `backend-deployment.yaml` | Backend Deployment (1 replica) + ClusterIP Service on `:8080` |
| `backend-secret.yaml.template` | DB, JWT, GitHub, AI, VPS config injected as env vars |
| `cleanup-cronjob.yaml` | Runs `cleanup.py` on schedule to delete stale sandbox Pods |
