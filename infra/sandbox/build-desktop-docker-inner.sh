#!/usr/bin/env bash
# Run *inside* ubuntu:24.04 with the host Docker socket mounted at /var/run/docker.sock
# (Docker Desktop Linux containers). Called by Windows setup.ps1, infra/local/setup.ps1, k8s/setup-local.ps1.
set -euo pipefail

export DOCKER_BUILDKIT=1

# docker.io from apt does not ship the buildx CLI plugin; BuildKit requires it when DOCKER_BUILDKIT=1.
install_docker_buildx() {
  local ver="${BUILDX_VERSION:-0.20.1}"
  local arch
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64) arch=arm64 ;;
    *) echo "[ERROR] Unsupported architecture for buildx: $(uname -m)" >&2; exit 1 ;;
  esac
  local url="https://github.com/docker/buildx/releases/download/v${ver}/buildx-v${ver}.linux-${arch}"
  mkdir -p /root/.docker/cli-plugins
  # Try normal curl first, fall back to --insecure if certs aren't fully trusted yet
  curl -fsSL "$url" -o /root/.docker/cli-plugins/docker-buildx || \
    curl -fsSL -k "$url" -o /root/.docker/cli-plugins/docker-buildx
  chmod +x /root/.docker/cli-plugins/docker-buildx
  docker buildx version
}

echo '[DEBUG] apt-get update...' | tee build.log
apt-get update 2>&1 | tee -a build.log
echo '[DEBUG] apt-get install docker.io curl wget git ca-certificates...' | tee -a build.log
apt-get install -y docker.io curl wget git ca-certificates 2>&1 | tee -a build.log

# Install enterprise/corporate certs BEFORE any HTTPS downloads
# CERTS_DIR is mounted by setup.ps1 / setup.sh pointing to <repo>/certs/
if [ -n "${CERTS_DIR:-}" ] && [ -d "$CERTS_DIR" ]; then
    echo "[DEBUG] Installing custom certificates from $CERTS_DIR..." | tee -a build.log
    mkdir -p /usr/local/share/ca-certificates/custom
    cert_count=0
    for f in "$CERTS_DIR"/*.crt "$CERTS_DIR"/*.pem "$CERTS_DIR"/*.cer; do
        [ -f "$f" ] || continue
        cp "$f" /usr/local/share/ca-certificates/custom/
        cert_count=$((cert_count + 1))
        echo "  Found cert: $(basename "$f")" | tee -a build.log
    done
    if [ "$cert_count" -gt 0 ]; then
        update-ca-certificates 2>&1 | tee -a build.log
        echo "[DEBUG] Installed $cert_count custom certificate(s)" | tee -a build.log
    fi
fi

echo '[DEBUG] install docker buildx plugin...' | tee -a build.log
install_docker_buildx 2>&1 | tee -a build.log
echo '[DEBUG] running setup.sh...' | tee -a build.log
bash setup.sh 2>&1 | tee -a build.log
