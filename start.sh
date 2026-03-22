#!/bin/bash
# DevPilot — single entry point (macOS / Linux)
#
# Usage:
#   bash start.sh                      # interactive mode (asks Docker vs K8s)
#   bash start.sh --mode docker        # skip prompt, use Docker Compose
#   bash start.sh --mode k8s           # skip prompt, use Kubernetes
#   bash start.sh --rebuild            # force rebuild all images
#   bash start.sh --stop               # stop all services
#   bash start.sh --reset              # stop + wipe database

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$REPO_ROOT/.env"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
step()  { echo -e "\n${CYAN}==>${NC} $1"; }

# ── Parse --mode flag ─────────────────────────────────────────────────────────
MODE=""
PASSTHROUGH_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode) MODE="$2"; shift 2 ;;
        *)      PASSTHROUGH_ARGS+=("$1"); shift ;;
    esac
done

# ── .env check ────────────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
    warn ".env not found — creating from template..."
    cp "$REPO_ROOT/infra/local/.env.example" "$ENV_FILE"
    echo ""
    echo -e "${YELLOW}  !! Fill in .env at the repo root, then re-run this script.${NC}"
    echo ""
    exit 1
fi

# ── Handle --stop / --reset (delegate to whichever mode was last used) ────────
for arg in "${PASSTHROUGH_ARGS[@]}"; do
    if [ "$arg" = "--stop" ] || [ "$arg" = "--reset" ]; then
        if [ "$MODE" = "k8s" ]; then
            bash "$REPO_ROOT/infra/sandbox/k8s/setup-local.sh" "${PASSTHROUGH_ARGS[@]}"
        else
            bash "$REPO_ROOT/infra/local/setup.sh" "${PASSTHROUGH_ARGS[@]}"
        fi
        exit $?
    fi
done

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}==========================================${NC}"
echo -e "${CYAN}${BOLD}        DevPilot — Start                  ${NC}"
echo -e "${CYAN}${BOLD}==========================================${NC}"
echo ""

# ── Ask deployment mode if not provided ──────────────────────────────────────
if [ -z "$MODE" ]; then
    echo -e "  Choose a deployment mode:\n"
    echo -e "    ${BOLD}1)${NC} Docker Compose  — everything runs in containers locally (recommended)"
    echo -e "    ${BOLD}2)${NC} Kubernetes      — local K8s cluster (Docker Desktop / k3d / minikube)\n"
    read -rp "  Enter choice [1/2]: " CHOICE
    case "$CHOICE" in
        1|docker) MODE="docker" ;;
        2|k8s)    MODE="k8s"    ;;
        *)
            echo -e "\n${YELLOW}  Invalid choice. Defaulting to Docker Compose.${NC}\n"
            MODE="docker"
            ;;
    esac
fi

echo ""
info "Mode: ${BOLD}$MODE${NC}"

# ── Patch VPS__GatewayUrl in .env to match the selected mode ─────────────────
# Docker: backend container resolves 'sandbox-manager' via docker-compose DNS
#         (localhost:8090 is also correct when running dotnet run against a compose sandbox)
# K8s:    sandbox manager is exposed as a NodePort on localhost:30090
patch_gateway_url() {
    local new_url="$1"
    if grep -q "^VPS__GatewayUrl=" "$ENV_FILE"; then
        sed -i.bak "s|^VPS__GatewayUrl=.*|VPS__GatewayUrl=$new_url|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    else
        echo "VPS__GatewayUrl=$new_url" >> "$ENV_FILE"
    fi
    info "VPS__GatewayUrl set to: $new_url"
}

if [ "$MODE" = "docker" ]; then
    # Docker DNS: backend container resolves 'sandbox-manager' directly
    patch_gateway_url "http://sandbox-manager:8090"
elif [ "$MODE" = "k8s" ]; then
    # K8s NodePort is on the host. From inside a Docker container use host.docker.internal
    # (works on macOS/Windows Docker Desktop and Linux Docker 20.10+ with extra_hosts)
    patch_gateway_url "http://host.docker.internal:30090"
fi

# ── Helper: stop conflicting mode before starting ────────────────────────────

# In Docker mode: stop the K8s sandbox-manager, start full docker-compose stack
# In K8s mode:   stop only the docker-compose sandbox-manager (backend/frontend/postgres stay up)
#                and start the sandbox-manager in K8s instead

stop_compose_sandbox_manager() {
    local running
    running=$(docker compose -f "$REPO_ROOT/docker-compose.yml" ps -q sandbox-manager 2>/dev/null)
    if [ -n "$running" ]; then
        warn "Stopping docker-compose sandbox-manager (will run in K8s instead)..."
        docker compose -f "$REPO_ROOT/docker-compose.yml" stop sandbox-manager
        docker compose -f "$REPO_ROOT/docker-compose.yml" rm -f sandbox-manager
        info "docker-compose sandbox-manager stopped."
    fi
}

stop_full_docker_compose() {
    if docker compose -f "$REPO_ROOT/docker-compose.yml" ps -q 2>/dev/null | grep -q .; then
        warn "Docker Compose stack is running — stopping it before switching to Docker mode..."
        docker compose -f "$REPO_ROOT/docker-compose.yml" down
        info "Docker Compose stack stopped."
    fi
}

stop_k8s() {
    command -v kubectl &>/dev/null || return 0
    kubectl config current-context &>/dev/null || return 0
    kubectl cluster-info --request-timeout=5s &>/dev/null || return 0
    if [ -n "$(kubectl get namespace sandboxes --ignore-not-found -o name 2>/dev/null)" ]; then
        warn "K8s sandbox namespace found — removing it before switching to Docker..."
        kubectl delete namespace sandboxes --ignore-not-found
        info "K8s sandboxes namespace removed."
    fi
}

build_desktop_image() {
    if docker images -q devpilot-desktop:latest 2>/dev/null | grep -q . && [[ " ${PASSTHROUGH_ARGS[*]} " != *" --rebuild "* ]]; then
        info "devpilot-desktop already built. Skipping. (use --rebuild to force)"
    else
        if [[ "$OSTYPE" == "darwin"* ]]; then
            bash "$REPO_ROOT/infra/sandbox/mac/setup.sh"
        else
            if [ "$(id -u)" -eq 0 ]; then
                bash "$REPO_ROOT/infra/sandbox/linux/setup.sh"
            else
                warn "Sandbox image build skipped (not root). Run: sudo bash infra/sandbox/linux/setup.sh"
                warn "The stack will start but sandbox creation will fail until the image is built."
            fi
        fi
    fi
}

# ══════════════════════════════════════════════════════════════════════════════
# DOCKER COMPOSE MODE — all 4 services in docker-compose
# ══════════════════════════════════════════════════════════════════════════════
if [ "$MODE" = "docker" ]; then

    stop_k8s

    step "Step 1/2 — Building sandbox image (devpilot-desktop)..."
    build_desktop_image

    step "Step 2/2 — Starting postgres, backend, frontend, sandbox-manager (docker-compose)..."
    bash "$REPO_ROOT/infra/local/setup.sh" "${PASSTHROUGH_ARGS[@]}"

# ══════════════════════════════════════════════════════════════════════════════
# KUBERNETES MODE — sandbox-manager in K8s, rest in docker-compose
#   Ports in K8s mode:
#     sandbox-manager : localhost:30090  (K8s NodePort)
#     VNC per sandbox : localhost:30100+ (K8s NodePort pairs)
#     Bridge per sandbox: localhost:30101+
# ══════════════════════════════════════════════════════════════════════════════
elif [ "$MODE" = "k8s" ]; then

    # Stop only the sandbox-manager from docker-compose — keep backend/frontend/postgres running
    stop_compose_sandbox_manager

    step "Step 1/2 — Building sandbox image (devpilot-desktop)..."
    build_desktop_image

    step "Step 2/2a — Starting postgres, backend, frontend (docker-compose, without sandbox-manager)..."
    docker compose -f "$REPO_ROOT/docker-compose.yml" --env-file "$ENV_FILE" \
        up -d postgres devpilot-backend devpilot-frontend

    step "Step 2/2b — Setting up sandbox-manager in Kubernetes..."
    bash "$REPO_ROOT/infra/sandbox/k8s/setup-local.sh" "${PASSTHROUGH_ARGS[@]}"

fi
