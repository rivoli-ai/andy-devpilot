# DevPilot Sandbox — K8s Local Testing

Test the Kubernetes backend locally before deploying to a VPS.

## Prerequisites

Choose one local K8s option:

### Option A — Docker Desktop (easiest)
1. Docker Desktop → Settings → Kubernetes → **Enable Kubernetes**
2. Wait for the green "Kubernetes running" status

### Option B — k3d (recommended for dev — fastest start/stop)
```bash
# Install k3d
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash

# Create cluster with NodePorts exposed
k3d cluster create devpilot \
  --port "30090:30090@loadbalancer" \
  --port "30100-30110:30100-30110@loadbalancer" \
  --port "31100-31110:31100-31110@loadbalancer"
```

### Option C — minikube
```bash
minikube start --driver=docker
minikube tunnel &   # in a separate terminal
```

## Run the setup

```bash
# From the repo root
bash infra/sandbox/k8s/setup-local.sh

# Force rebuild of images
bash infra/sandbox/k8s/setup-local.sh --rebuild
```

The script will:
1. Build `devpilot-desktop` image and load it into the cluster
2. Build `devpilot-manager` image and load it into the cluster
3. Apply all K8s manifests (namespace, RBAC, deployment, service, secret)
4. Wait for the manager pod to be ready
5. Print the `appsettings.json` snippet to copy

## Configure the backend

After running setup, update `backend/src/API/appsettings.Development.json`:

```json
"VPS": {
  "GatewayUrl":    "http://localhost:30090",
  "ManagerApiKey": "<key shown at end of setup>",
  "PublicIp":      "localhost",
  "Enabled":       true
}
```

## Verify everything works

```bash
# Check pods
kubectl get pods -n sandboxes

# Check manager logs
kubectl logs -f deployment/sandbox-manager -n sandboxes

# Health check
curl http://localhost:30090/health
# {"status":"ok","version":"3.0.0","backend":"k8s","active_sandboxes":0}

# Create a test sandbox (replace <API_KEY>)
curl -X POST http://localhost:30090/sandboxes \
  -H "X-Api-Key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{}'
# Returns: {id, port (30100), bridge_port (31100), url, bridge_url, sandbox_token, vnc_password}

# List sandboxes
curl http://localhost:30090/sandboxes -H "X-Api-Key: <API_KEY>"

# Check the sandbox pod
kubectl get pods -n sandboxes
# NAME                   READY   STATUS    AGE
# sandbox-manager-xxx    1/1     Running   2m
# sandbox-a1b2c3d4       1/1     Running   30s

# Delete sandbox
curl -X DELETE http://localhost:30090/sandboxes/a1b2c3d4 -H "X-Api-Key: <API_KEY>"
```

## Ports

| Service | NodePort | Usage |
|---------|----------|-------|
| Manager API | 30090 | `.NET backend → manager` |
| noVNC sandbox #1 | 30100 | `browser iframe` |
| noVNC sandbox #2 | 30101 | `browser iframe` |
| Bridge API sandbox #1 | 31100 | `browser → bridge` |
| Bridge API sandbox #2 | 31101 | `browser → bridge` |

## Teardown

```bash
# Stop everything
kubectl delete namespace sandboxes

# Delete k3d cluster (if using k3d)
k3d cluster delete devpilot
```
