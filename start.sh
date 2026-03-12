#!/bin/bash
# DevPilot — single entry point (macOS / Linux)
#
# Usage:
#   bash start.sh             # start the full stack
#   bash start.sh --rebuild   # force rebuild all images
#   bash start.sh --stop      # stop all services
#   bash start.sh --reset     # stop + wipe database

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$REPO_ROOT/.env"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
step()  { echo -e "\n${CYAN}==>${NC} $1"; }

# ── .env check ────────────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
    warn ".env not found — creating from template..."
    cp "$REPO_ROOT/infra/local/.env.example" "$ENV_FILE"
    echo ""
    echo -e "${YELLOW}  !! Fill in .env at the repo root, then re-run this script.${NC}"
    echo ""
    exit 1
fi

# ── Handle --stop / --reset without building the sandbox image ────────────────
for arg in "$@"; do
    if [ "$arg" = "--stop" ] || [ "$arg" = "--reset" ]; then
        bash "$REPO_ROOT/infra/local/setup.sh" "$@"
        exit $?
    fi
done

echo ""
echo -e "${CYAN}==========================================${NC}"
echo -e "${CYAN}   DevPilot — Starting full stack         ${NC}"
echo -e "${CYAN}==========================================${NC}"
echo ""

# ── Step 1: Build devpilot-desktop sandbox image ─────────────────────────────
step "Step 1/2 — Building sandbox image (devpilot-desktop)..."

if docker images -q devpilot-desktop:latest 2>/dev/null | grep -q . && [[ "$*" != *"--rebuild"* ]]; then
    info "devpilot-desktop already built. Skipping. (use --rebuild to force)"
else
    if [[ "$OSTYPE" == "darwin"* ]]; then
        bash "$REPO_ROOT/infra/sandbox/mac/setup.sh"
    else
        # Linux — requires root for VPS setup; skip silently in CI/Docker-only environments
        if [ "$(id -u)" -eq 0 ]; then
            bash "$REPO_ROOT/infra/sandbox/linux/setup.sh"
        else
            warn "Sandbox image build skipped (not root). Run: sudo bash infra/sandbox/linux/setup.sh"
            warn "The stack will still start but sandbox creation will fail until the image is built."
        fi
    fi
fi

# ── Step 2: Start backend + frontend + postgres + sandbox-manager ─────────────
step "Step 2/2 — Starting backend, frontend, postgres, sandbox manager..."
bash "$REPO_ROOT/infra/local/setup.sh" "$@"
