#!/bin/bash
# DevPilot Sandbox — Local K8s setup
# Works with: Docker Desktop K8s, k3d, or minikube
#
# Usage:
#   bash infra/sandbox/k8s/setup-local.sh [--api-key YOUR_KEY] [--rebuild]
#
# What it does:
#   1. Detects which local K8s is running
#   2. Builds devpilot-desktop image (loads into cluster)
#   3. Builds devpilot-manager image (loads into cluster)
#   4. Applies K8s manifests
#   5. Waits for manager pod to be ready
#   6. Prints backend appsettings snippet

set -e

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
step()    { echo -e "\n${CYAN}==>${NC} $1"; }

# ── Parse args ────────────────────────────────────────────────────────────────
API_KEY=""
REBUILD=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --api-key) API_KEY="$2"; shift 2 ;;
        --rebuild) REBUILD=true; shift ;;
        *) shift ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SANDBOX_DIR="$REPO_ROOT/infra/sandbox"
MANAGER_DIR="$SANDBOX_DIR/manager"
MANIFESTS_DIR="$REPO_ROOT/infra/k8s/manifests"

# ── 1. Check prerequisites ─────────────────────────────────────────────────
step "Checking prerequisites..."

command -v kubectl &>/dev/null || error "kubectl not found. Install Docker Desktop or k3d."
command -v docker  &>/dev/null || error "docker not found."

# Detect cluster type
CLUSTER_TYPE="unknown"
CONTEXT=$(kubectl config current-context 2>/dev/null || echo "")
if echo "$CONTEXT" | grep -qi "docker-desktop"; then
    CLUSTER_TYPE="docker-desktop"
elif echo "$CONTEXT" | grep -qi "k3d"; then
    CLUSTER_TYPE="k3d"
elif echo "$CONTEXT" | grep -qi "minikube"; then
    CLUSTER_TYPE="minikube"
fi

info "Cluster context: $CONTEXT (type: $CLUSTER_TYPE)"
kubectl cluster-info --request-timeout=5s &>/dev/null || error "K8s cluster is not reachable. Start Docker Desktop K8s or k3d."
info "K8s cluster is reachable"

# ── 2. Generate API key ────────────────────────────────────────────────────
step "Configuring API key..."

if [ -z "$API_KEY" ]; then
    # Check if already generated
    EXISTING=$(kubectl get secret manager-secrets -n sandboxes -o jsonpath='{.data.MANAGER_API_KEY}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
    if [ -n "$EXISTING" ]; then
        API_KEY="$EXISTING"
        info "Reusing existing API key from K8s secret"
    else
        API_KEY=$(openssl rand -base64 32 | tr -d '\n/+=' | head -c 43)
        info "Generated new API key"
    fi
fi

# ── 3. Build desktop image ─────────────────────────────────────────────────
step "Building devpilot-desktop image..."

if docker images -q devpilot-desktop:latest 2>/dev/null | grep -q .; then
    if [ "$REBUILD" = false ]; then
        info "devpilot-desktop image already exists. Use --rebuild to force rebuild."
    else
        warn "Forcing rebuild of devpilot-desktop..."
        bash "$SANDBOX_DIR/setup.sh" --build-only || true
    fi
else
    info "Building desktop image (this takes 10-20 min first time)..."
    BUILD_ONLY=1 bash "$SANDBOX_DIR/setup.sh"
fi

# Load image into cluster
if [ "$CLUSTER_TYPE" = "k3d" ]; then
    CLUSTER_NAME=$(kubectl config current-context | sed 's/k3d-//')
    info "Loading devpilot-desktop into k3d cluster '$CLUSTER_NAME'..."
    k3d image import devpilot-desktop:latest -c "$CLUSTER_NAME"
elif [ "$CLUSTER_TYPE" = "minikube" ]; then
    info "Loading devpilot-desktop into minikube..."
    minikube image load devpilot-desktop:latest
else
    info "Docker Desktop K8s shares the Docker daemon — image already available"
fi

# ── 4. Build manager image ─────────────────────────────────────────────────
step "Building devpilot-manager image..."

docker build -t devpilot-manager:local "$MANAGER_DIR"

if [ "$CLUSTER_TYPE" = "k3d" ]; then
    CLUSTER_NAME=$(kubectl config current-context | sed 's/k3d-//')
    k3d image import devpilot-manager:local -c "$CLUSTER_NAME"
elif [ "$CLUSTER_TYPE" = "minikube" ]; then
    minikube image load devpilot-manager:local
fi

info "Manager image built"

# ── 5. Apply K8s manifests ─────────────────────────────────────────────────
step "Applying K8s manifests..."

kubectl apply -f "$MANIFESTS_DIR/namespace.yaml"
kubectl apply -f "$MANIFESTS_DIR/rbac.yaml"

# Create/update the secret
kubectl create secret generic manager-secrets \
    --from-literal=MANAGER_API_KEY="$API_KEY" \
    --from-literal=HOST_IP="localhost" \
    --from-literal=BACKEND="k8s" \
    --from-literal=SANDBOX_IMAGE="devpilot-desktop:latest" \
    --from-literal=IMAGE_PULL_SECRET="" \
    -n sandboxes \
    --dry-run=client -o yaml | kubectl apply -f -

# Patch deployment to use local image (not GHCR) and Never pull (local image)
sed \
    -e 's|ghcr.io/YOUR_ORG/devpilot-manager:latest|devpilot-manager:local|g' \
    -e 's|imagePullPolicy: Always|imagePullPolicy: Never|g' \
    "$MANIFESTS_DIR/manager-deployment.yaml" | kubectl apply -f -

info "Manifests applied"

# ── 6. Wait for manager pod ────────────────────────────────────────────────
step "Waiting for sandbox-manager pod to be ready..."

kubectl rollout restart deployment/sandbox-manager -n sandboxes 2>/dev/null || true
kubectl rollout status deployment/sandbox-manager -n sandboxes --timeout=120s

info "Manager is ready"

# ── 7. Health check ─────────────────────────────────────────────────────────
step "Health check..."

sleep 3
HEALTH=$(curl -sf http://localhost:30090/health 2>/dev/null || echo "")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
    info "Manager health check passed: $HEALTH"
else
    warn "Manager did not respond at :30090 yet."
    warn "Check logs: kubectl logs -f deployment/sandbox-manager -n sandboxes"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  K8s local setup complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  Manager API  : ${CYAN}http://localhost:30090${NC}"
echo -e "  API key      : ${CYAN}$API_KEY${NC}"
echo ""
echo "  Update your backend/src/API/appsettings.Development.json:"
echo '  "VPS": {'
echo '    "GatewayUrl":    "http://localhost:30090",'
echo "    \"ManagerApiKey\": \"$API_KEY\","
echo '    "PublicIp":      "localhost",'
echo '    "Enabled":       true'
echo '  }'
echo ""
echo "  Useful commands:"
echo "    kubectl get pods -n sandboxes"
echo "    kubectl logs -f deployment/sandbox-manager -n sandboxes"
echo "    kubectl get services -n sandboxes"
echo ""
