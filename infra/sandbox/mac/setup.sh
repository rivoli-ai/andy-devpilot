#!/bin/bash
# DevPilot Sandbox — macOS entry point
# Delegates to the shared setup.sh at the parent directory.
# Do NOT run with sudo on macOS (installs to ~/.devpilot-sandbox/).

set -e

if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "[ERROR] This script is for macOS only."
    echo "        Linux users: use infra/sandbox/linux/setup.sh"
    echo "        Windows users: use infra/sandbox/windows/setup.ps1"
    exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
    echo "[WARN] Running as root on macOS is not recommended."
    echo "       The sandbox will install to /root/.devpilot-sandbox instead of your home directory."
    read -p "Continue anyway? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || exit 0
fi

if ! command -v docker &>/dev/null; then
    echo "[ERROR] docker CLI not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop"
    exit 1
fi
if ! docker info &>/dev/null; then
    echo "[ERROR] Cannot connect to the Docker daemon (e.g. unix://\$HOME/.docker/run/docker.sock)."
    echo "        Fix:"
    echo "          1) Open Docker Desktop and wait until the engine is running."
    echo "          2) docker context use default"
    echo "          3) docker info   # should succeed"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/../setup.sh" "$@"
