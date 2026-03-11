#!/bin/bash
# DevPilot Sandbox — Linux entry point
# Delegates to the shared setup.sh at the parent directory.
# Must be run as root (sudo) on a Linux VPS.

set -e

if [ "$(id -u)" -ne 0 ]; then
    echo "[ERROR] This script must be run as root. Use: sudo bash setup.sh"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/../setup.sh" "$@"
