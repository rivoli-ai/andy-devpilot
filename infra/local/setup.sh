#!/bin/bash
# DevPilot — Full local stack setup (macOS / Linux)
# Builds and starts: PostgreSQL + Backend + Frontend + Sandbox Manager
#
# Usage:
#   bash infra/local/setup.sh            # start all services
#   bash infra/local/setup.sh --rebuild  # force rebuild all images
#   bash infra/local/setup.sh --stop     # stop all services
#   bash infra/local/setup.sh --reset    # stop + remove volumes (wipes DB)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
step()  { echo -e "\n${CYAN}==>${NC} $1"; }

# ── Parse args ────────────────────────────────────────────────────────────────
REBUILD=false
STOP=false
RESET=false
for arg in "$@"; do
    case $arg in
        --rebuild) REBUILD=true ;;
        --stop)    STOP=true ;;
        --reset)   RESET=true ;;
    esac
done

# ── Stop / Reset ──────────────────────────────────────────────────────────────
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
echo -e "${CYAN}   DevPilot — Local Stack Setup           ${NC}"
echo -e "${CYAN}==========================================${NC}"
echo ""

# ── 1. Check prerequisites ────────────────────────────────────────────────────
step "Checking prerequisites..."
command -v docker &>/dev/null  || error "Docker not found. Install Docker Desktop."
docker info &>/dev/null        || error "Docker daemon is not running."
command -v docker &>/dev/null && docker compose version &>/dev/null || error "docker compose not found."
info "Docker is running"

# ── 2. Create .env if missing ─────────────────────────────────────────────────
step "Checking .env configuration..."
if [ ! -f "$ENV_FILE" ]; then
    warn ".env not found — creating from template..."
    cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
    echo ""
    echo -e "${YELLOW}  !! ACTION REQUIRED: Edit .env at the repo root and fill in your values, then re-run this script.${NC}"
    echo ""
    exit 1
fi
info ".env found at $ENV_FILE"

# ── 3. Build devpilot-desktop image (needed by sandbox manager) ───────────────
step "Checking devpilot-desktop image..."
if docker images -q devpilot-desktop:latest 2>/dev/null | grep -q .; then
    if [ "$REBUILD" = false ]; then
        info "devpilot-desktop already exists. Use --rebuild to force rebuild."
    else
        warn "Rebuilding devpilot-desktop..."
        BUILD_ONLY=1 bash "$REPO_ROOT/infra/sandbox/setup.sh"
    fi
else
    info "Building devpilot-desktop (this takes 10-20 min first time)..."
    BUILD_ONLY=1 bash "$REPO_ROOT/infra/sandbox/setup.sh"
fi

# ── 4. Build and start all services ──────────────────────────────────────────
step "Building and starting all services..."

if [ "$REBUILD" = true ]; then
    warn "Rebuilding all images from scratch (--no-cache)..."
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build --no-cache
fi

docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate

# ── 5. Wait for backend to be ready ──────────────────────────────────────────
step "Waiting for backend to be ready..."
RETRIES=60
until curl -sf http://localhost:8080/health &>/dev/null || [ $RETRIES -eq 0 ]; do
    sleep 3
    RETRIES=$((RETRIES - 1))
done
if [ $RETRIES -eq 0 ]; then
    warn "Backend did not respond. Check logs: docker compose logs devpilot-backend"
else
    info "Backend is ready"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}  DevPilot local stack is running!        ${NC}"
echo -e "${GREEN}==========================================${NC}"
echo ""
echo -e "  Frontend        : ${CYAN}http://localhost${NC}"
echo -e "  Backend API     : ${CYAN}http://localhost:8080/api${NC}"
echo -e "  Sandbox Manager : ${CYAN}http://localhost:8090/health${NC}"
echo -e "  PostgreSQL      : ${CYAN}localhost:5432${NC}"
echo ""
echo "  Logs:"
echo "    docker compose logs -f devpilot-backend"
echo "    docker compose logs -f devpilot-frontend"
echo "    docker compose logs -f sandbox-manager"
echo ""
echo "  Stop:  bash infra/local/setup.sh --stop"
echo "  Reset: bash infra/local/setup.sh --reset   (wipes DB)"
echo ""
