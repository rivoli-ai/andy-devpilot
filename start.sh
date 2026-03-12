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

# ══════════════════════════════════════════════════════════════════════════════
# DOCKER COMPOSE MODE
# ══════════════════════════════════════════════════════════════════════════════
if [ "$MODE" = "docker" ]; then

    # Step 1 — Build devpilot-desktop
    step "Step 1/2 — Building sandbox image (devpilot-desktop)..."
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

    # Step 2 — Start docker-compose stack
    step "Step 2/2 — Starting backend, frontend, postgres, sandbox manager..."
    bash "$REPO_ROOT/infra/local/setup.sh" "${PASSTHROUGH_ARGS[@]}"

# ══════════════════════════════════════════════════════════════════════════════
# KUBERNETES MODE
# ══════════════════════════════════════════════════════════════════════════════
elif [ "$MODE" = "k8s" ]; then

    # Step 1 — Build devpilot-desktop
    step "Step 1/2 — Building sandbox image (devpilot-desktop)..."
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
            fi
        fi
    fi

    # Step 2 — Set up K8s cluster
    step "Step 2/2 — Setting up Kubernetes cluster..."
    bash "$REPO_ROOT/infra/sandbox/k8s/setup-local.sh" "${PASSTHROUGH_ARGS[@]}"

fi
