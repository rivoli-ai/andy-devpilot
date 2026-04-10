#!/bin/bash
# DevPilot — deploy sandbox manager only (no frontend, backend, or postgres)
#
# - Ensures devpilot-desktop image exists (or builds via sandbox setup when missing / --build-desktop)
# - Starts only the sandbox-manager Compose service
#
# Usage:
#   bash deploy.sh
#   bash deploy.sh --build-desktop   # run infra/sandbox/setup.sh even if devpilot-desktop:latest exists
#   bash deploy.sh --stop            # stop sandbox-manager only
#   bash deploy.sh --reset           # remove sandbox-manager container (next deploy recreates it)

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$REPO_ROOT/.env"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
SANDBOX_SETUP="$REPO_ROOT/infra/sandbox/setup.sh"
LOCAL_DIR="$REPO_ROOT/infra/local"
MANAGER_SERVICE="sandbox-manager"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
step()  { echo -e "\n${CYAN}==>${NC} $1"; }

BUILD_DESKTOP=false
STOP=false
RESET=false
for arg in "$@"; do
    case $arg in
        --build-desktop) BUILD_DESKTOP=true ;;
        --stop)          STOP=true ;;
        --reset)         RESET=true ;;
    esac
done

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

if [ "$STOP" = true ]; then
    step "Stopping ${MANAGER_SERVICE}..."
    compose stop "$MANAGER_SERVICE"
    info "${MANAGER_SERVICE} stopped (other compose services unchanged)."
    exit 0
fi

if [ "$RESET" = true ]; then
    step "Removing ${MANAGER_SERVICE} container..."
    compose rm -sf "$MANAGER_SERVICE" 2>/dev/null || true
    info "${MANAGER_SERVICE} removed. Run deploy.sh again to recreate."
    exit 0
fi

echo ""
echo -e "${CYAN}==========================================${NC}"
echo -e "${CYAN}   DevPilot — sandbox manager deploy        ${NC}"
echo -e "${CYAN}==========================================${NC}"
echo ""

step "Checking prerequisites..."
command -v docker &>/dev/null  || error "Docker not found. Install Docker Desktop."
docker info &>/dev/null        || error "Docker daemon is not running."
docker compose version &>/dev/null || error "docker compose not found."
info "Docker is running"

step "Checking .env configuration..."
if [ ! -f "$ENV_FILE" ]; then
    warn ".env not found — creating from template..."
    cp "$LOCAL_DIR/.env.example" "$ENV_FILE"
    echo ""
    echo -e "${YELLOW}  !! ACTION REQUIRED: Edit .env at the repo root, then re-run deploy.sh.${NC}"
    echo ""
    exit 1
fi
info ".env found at $ENV_FILE"

step "devpilot-desktop image..."
_desktop_exists=false
if docker images -q devpilot-desktop:latest 2>/dev/null | grep -q .; then
    _desktop_exists=true
fi

if [ "$BUILD_DESKTOP" = true ]; then
    warn "Building desktop image via sandbox setup (BUILD_ONLY)..."
    BUILD_ONLY=1 bash "$SANDBOX_SETUP"
elif [ "$_desktop_exists" = true ]; then
    info "Using existing devpilot-desktop:latest (omit --build-desktop to keep this behavior)."
else
    info "No devpilot-desktop:latest — running sandbox setup (first run can take 10–20 min)..."
    BUILD_ONLY=1 bash "$SANDBOX_SETUP"
fi

step "Starting ${MANAGER_SERVICE} (frontend/backend/postgres are not started)..."
compose up -d "$MANAGER_SERVICE"

step "Waiting for sandbox manager health..."
RETRIES=60
until curl -sf http://localhost:8090/health &>/dev/null || [ "$RETRIES" -eq 0 ]; do
    sleep 2
    RETRIES=$((RETRIES - 1))
done
if [ "$RETRIES" -eq 0 ]; then
    warn "Sandbox manager did not respond on :8090. Check logs: docker compose logs ${MANAGER_SERVICE}"
else
    info "Sandbox manager is ready"
fi

echo ""
echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}  Sandbox manager is up                    ${NC}"
echo -e "${GREEN}==========================================${NC}"
echo ""
echo -e "  Sandbox Manager : ${CYAN}http://localhost:8090/health${NC}"
echo ""
echo "  Full stack (frontend + backend + DB): bash infra/local/setup.sh"
echo "  Stop manager only:  bash deploy.sh --stop"
echo "  Reset manager only: bash deploy.sh --reset"
echo "  Rebuild desktop image: bash deploy.sh --build-desktop"
echo ""
