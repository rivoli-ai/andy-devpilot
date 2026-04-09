#!/bin/bash
# DevPilot — deploy local Docker Compose stack reusing existing images when possible
#
# Unlike infra/local/setup.sh, this never tears down or rebuilds by default:
#   - devpilot-desktop: runs sandbox setup only if devpilot-desktop:latest is missing
#   - compose services: docker compose up -d (builds only what Compose considers needed; no --no-cache, no --force-recreate)
#
# Usage:
#   bash deploy.sh
#   bash deploy.sh --build-desktop   # run infra/sandbox/setup.sh (BUILD_ONLY) even if the image exists
#   bash deploy.sh --stop
#   bash deploy.sh --reset           # stop + remove volumes (wipes DB)

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$REPO_ROOT/.env"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
SANDBOX_SETUP="$REPO_ROOT/infra/sandbox/setup.sh"
LOCAL_DIR="$REPO_ROOT/infra/local"

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

if [ "$STOP" = true ]; then
    step "Stopping all services..."
    docker compose -f "$COMPOSE_FILE" down
    info "All services stopped."
    exit 0
fi

if [ "$RESET" = true ]; then
    step "Stopping all services and removing volumes (this wipes the database)..."
    docker compose -f "$COMPOSE_FILE" down -v
    info "All services stopped and volumes removed."
    exit 0
fi

echo ""
echo -e "${CYAN}==========================================${NC}"
echo -e "${CYAN}   DevPilot — deploy (reuse images)       ${NC}"
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

step "Starting stack (compose will build service images only if needed)..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

step "Waiting for backend health..."
RETRIES=60
until curl -sf http://localhost:5000/health &>/dev/null || [ "$RETRIES" -eq 0 ]; do
    sleep 3
    RETRIES=$((RETRIES - 1))
done
if [ "$RETRIES" -eq 0 ]; then
    warn "Backend did not respond. Check logs: docker compose logs devpilot-backend"
else
    info "Backend is ready"
fi

echo ""
echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}  Stack is up                             ${NC}"
echo -e "${GREEN}==========================================${NC}"
echo ""
echo -e "  Frontend        : ${CYAN}http://localhost${NC}"
echo -e "  Backend API     : ${CYAN}http://localhost:5000/api${NC}"
echo -e "  Sandbox Manager : ${CYAN}http://localhost:8090/health${NC}"
echo ""
echo "  Stop:  bash deploy.sh --stop"
echo "  Reset: bash deploy.sh --reset"
echo "  Rebuild sandbox image: bash deploy.sh --build-desktop"
echo ""
