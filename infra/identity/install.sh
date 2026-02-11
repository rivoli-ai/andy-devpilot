#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# DevPilot Identity Server – install script (macOS / Linux)
#
# Usage:
#   ./install.sh                       # generate certs + start
#   ./install.sh --no-certs            # skip cert generation (use existing)
#   ./install.sh --trust-cert          # also trust cert in OS store (macOS)
#   ./install.sh --username admin      # override admin username
#   ./install.sh --port 5001           # override IDS port
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Fix Windows CRLF line endings (WSL) ─────────────────────────────────────
# If this script was checked out on Windows, fix line endings for Docker/sh
if command -v dos2unix &>/dev/null; then
  dos2unix "$0" 2>/dev/null || true
elif command -v sed &>/dev/null; then
  # Fix CRLF in this script and docker-compose.yml
  sed -i 's/\r$//' "$0" 2>/dev/null || true
  sed -i 's/\r$//' docker-compose.yml 2>/dev/null || true
fi

# ── Defaults ─────────────────────────────────────────────────────────────────
GENERATE_CERTS=true
TRUST_CERT=false
IDS_PORT=5001
ADMIN_USERNAME="ibenamara"
ADMIN_EMAIL=""
ADMIN_DISPLAY_NAME=""
CERT_PASSWORD="devpassword"

# ── Parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-certs)      GENERATE_CERTS=false; shift ;;
    --trust-cert)    TRUST_CERT=true; shift ;;
    --port)          IDS_PORT="$2"; shift 2 ;;
    --username)      ADMIN_USERNAME="$2"; shift 2 ;;
    --email)         ADMIN_EMAIL="$2"; shift 2 ;;
    --display-name)  ADMIN_DISPLAY_NAME="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --no-certs       Skip certificate generation (reuse existing certs/)"
      echo "  --trust-cert     Trust the certificate in the OS store (macOS only)"
      echo "  --port PORT      Identity server port (default: 5001)"
      echo "  --username NAME  Admin username (default: ibenamara)"
      echo "  --email EMAIL    Admin email"
      echo "  --display-name N Admin display name"
      echo "  -h, --help       Show this help"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Derived defaults ─────────────────────────────────────────────────────────
ADMIN_EMAIL="${ADMIN_EMAIL:-${ADMIN_USERNAME}@devpilot.local}"
ADMIN_DISPLAY_NAME="${ADMIN_DISPLAY_NAME:-${ADMIN_USERNAME}}"

# ── Check dependencies ───────────────────────────────────────────────────────
echo "==> Checking dependencies..."
for cmd in docker openssl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' is required but not found. Please install it first."
    exit 1
  fi
done

if ! docker info &>/dev/null; then
  echo "ERROR: Docker is not running. Please start Docker Desktop first."
  exit 1
fi

echo "    docker  ✓"
echo "    openssl ✓"

# ── Install enterprise/proxy CA certificates (SSL interception) ──────────────
# Looks for .crt/.pem files in:
#   1. ./enterprise-certs/    (identity-specific)
#   2. ../sandbox/certs/      (shared with sandbox)
# Installs them into the host OS trust store so Docker can pull images correctly.
echo ""
echo "==> Checking for enterprise CA certificates..."
ENTERPRISE_CERT_COUNT=0

install_host_certs() {
  local src_dir="$1"
  if [ -d "$src_dir" ]; then
    for f in "$src_dir"/*.crt "$src_dir"/*.pem; do
      [ -f "$f" ] || continue
      local fname
      fname=$(basename "$f")
      # Skip localhost certs (those are for the identity server itself)
      [[ "$fname" == localhost* ]] && continue
      echo "    Found: $fname (from $src_dir)"
      sudo cp "$f" /usr/local/share/ca-certificates/"$fname" 2>/dev/null || \
        cp "$f" /usr/local/share/ca-certificates/"$fname" 2>/dev/null || true
      ENTERPRISE_CERT_COUNT=$((ENTERPRISE_CERT_COUNT + 1))
    done
  fi
}

# Auto-extract enterprise CA from live connections (catches proxy-injected CAs)
mkdir -p ./enterprise-certs
if [ ! -f ./enterprise-certs/auto-proxy-ca.crt ] || [ "$ENTERPRISE_CERT_COUNT" -eq 0 ]; then
  echo "    Attempting to auto-detect proxy CA from live connections..."
  for HOST in registry-1.docker.io hub.docker.com google.com; do
    EXTRACTED=$(echo | openssl s_client -showcerts -connect "${HOST}:443" -servername "${HOST}" 2>/dev/null | \
      awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' 2>/dev/null)
    if [ -n "$EXTRACTED" ]; then
      echo "$EXTRACTED" > "./enterprise-certs/auto-${HOST}.crt"
      echo "    Extracted cert chain from $HOST"
    fi
  done
fi

install_host_certs "./enterprise-certs"
install_host_certs "../sandbox/certs"

if [ "$ENTERPRISE_CERT_COUNT" -gt 0 ]; then
  echo "    Installing $ENTERPRISE_CERT_COUNT cert(s) into host trust store..."
  sudo update-ca-certificates 2>/dev/null || update-ca-certificates 2>/dev/null || true
  echo "    Restarting Docker to pick up new CAs..."
  sudo systemctl restart docker 2>/dev/null || sudo service docker restart 2>/dev/null || true
  # Wait for Docker to be ready again
  for i in $(seq 1 15); do
    docker info &>/dev/null && break
    sleep 1
  done
  echo "    Enterprise CA certificates installed ✓"
else
  echo "    No enterprise certs found."
  echo "    If behind a corporate proxy (Zscaler, etc.), place your root CA .crt files in:"
  echo "      ./enterprise-certs/   or   ../sandbox/certs/"
  echo "    Then re-run this script."
fi

# ── Generate admin password ──────────────────────────────────────────────────
ADMIN_PASSWORD="$(openssl rand -base64 16 | tr -d '/+=' | head -c 16)Dp1!"
echo ""
echo "==> Admin credentials"
echo "    Username : $ADMIN_USERNAME"
echo "    Password : $ADMIN_PASSWORD"
echo "    Email    : $ADMIN_EMAIL"

# ── Generate certificates ────────────────────────────────────────────────────
if [ "$GENERATE_CERTS" = true ]; then
  echo ""
  echo "==> Generating self-signed certificates..."
  mkdir -p certs

  openssl req -x509 -newkey rsa:2048 \
    -keyout certs/localhost.key \
    -out certs/localhost.crt \
    -days 365 -nodes \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    2>/dev/null

  # Generate PFX with legacy algorithms for .NET container compatibility
  openssl pkcs12 -export \
    -out certs/localhost.pfx \
    -inkey certs/localhost.key \
    -in certs/localhost.crt \
    -passout "pass:${CERT_PASSWORD}" \
    -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 \
    2>/dev/null

  echo "    certs/localhost.crt ✓"
  echo "    certs/localhost.pfx ✓"
else
  if [ ! -f certs/localhost.pfx ]; then
    echo "ERROR: certs/localhost.pfx not found. Remove --no-certs to generate."
    exit 1
  fi
  echo ""
  echo "==> Using existing certificates in certs/"
fi

# ── Build CA bundle for the container ─────────────────────────────────────────
# The Duende image has no shell, so we can't run update-ca-certificates inside it.
# Instead, we build a combined CA bundle and mount it directly.
echo ""
echo "==> Building CA bundle for container..."

# Start with the system CA bundle
CA_BUNDLE="certs/ca-bundle.crt"
if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
  cp /etc/ssl/certs/ca-certificates.crt "$CA_BUNDLE"
elif [ -f /etc/pki/tls/certs/ca-bundle.crt ]; then
  cp /etc/pki/tls/certs/ca-bundle.crt "$CA_BUNDLE"
else
  # Start empty if no system bundle found
  > "$CA_BUNDLE"
fi

# Append localhost self-signed cert
if [ -f certs/localhost.crt ]; then
  echo "" >> "$CA_BUNDLE"
  echo "# DevPilot localhost self-signed" >> "$CA_BUNDLE"
  cat certs/localhost.crt >> "$CA_BUNDLE"
fi

# Append enterprise certs
for dir in ./enterprise-certs ../sandbox/certs; do
  if [ -d "$dir" ]; then
    for f in "$dir"/*.crt "$dir"/*.pem; do
      [ -f "$f" ] || continue
      [[ "$(basename "$f")" == localhost* ]] && continue
      echo "" >> "$CA_BUNDLE"
      echo "# Enterprise: $(basename "$f")" >> "$CA_BUNDLE"
      cat "$f" >> "$CA_BUNDLE"
    done
  fi
done

BUNDLE_CERTS=$(grep -c "BEGIN CERTIFICATE" "$CA_BUNDLE" 2>/dev/null || echo "0")
echo "    $CA_BUNDLE ✓ ($BUNDLE_CERTS certificates)"

# ── Trust certificate (macOS only) ──────────────────────────────────────────
if [ "$TRUST_CERT" = true ]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    echo ""
    echo "==> Trusting certificate in macOS Keychain (requires sudo)..."
    sudo security add-trusted-cert -d -r trustRoot \
      -k /Library/Keychains/System.keychain \
      certs/localhost.crt
    echo "    Certificate trusted ✓"
  else
    echo ""
    echo "==> Trusting certificate in system CA store..."
    sudo cp certs/localhost.crt /usr/local/share/ca-certificates/devpilot-localhost.crt
    sudo update-ca-certificates 2>/dev/null
    echo "    Certificate trusted ✓"
  fi
fi

# ── Write .env file ─────────────────────────────────────────────────────────
echo ""
echo "==> Writing .env file..."
cat > .env <<EOF
# Generated by install.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
IDS_PORT=${IDS_PORT}
CERT_PASSWORD=${CERT_PASSWORD}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_DISPLAY_NAME=${ADMIN_DISPLAY_NAME}
REDIS_PORT=6379
EOF
echo "    .env ✓"

# ── Update blazor-appsettings.json with the correct port ────────────────────
echo ""
echo "==> Updating blazor-appsettings.json for port ${IDS_PORT}..."
python3 -c "
import json
with open('blazor-appsettings.json', 'r') as f:
    d = json.load(f)
port = '${IDS_PORT}'
base = f'https://localhost:{port}'
d['apiBaseUrl'] = f'{base}/api'
d['providerOptions']['authority'] = f'{base}/'
d['providerOptions']['redirectUri'] = f'{base}/authentication/login-callback'
d['providerOptions']['postLogoutRedirectUri'] = f'{base}/authentication/logout-callback'
d['settingsOptions']['apiUrl'] = f'{base}/api/api/configuration'
with open('blazor-appsettings.json', 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
" 2>/dev/null || echo "    (python3 not available – blazor-appsettings.json uses default port 5001)"
echo "    blazor-appsettings.json ✓"

# ── Verify certs exist before starting ────────────────────────────────────────
echo ""
echo "==> Verifying certificates..."
for f in certs/localhost.crt certs/localhost.key certs/localhost.pfx; do
  if [ ! -f "$f" ]; then
    echo "ERROR: $f not found. Cannot start without certificates."
    echo "       Re-run without --no-certs to generate them."
    exit 1
  fi
  echo "    $f ✓"
done

# ── Enable QEMU emulation for cross-arch images (needed on ARM for amd64) ────
ARCH=$(uname -m)
echo ""
echo "==> Host architecture: $ARCH"
if [[ "$ARCH" != "x86_64" && "$ARCH" != "amd64" ]]; then
  echo "    The Duende image is amd64-only. Installing QEMU emulation..."
  if docker run --privileged --rm tonistiigi/binfmt --install amd64; then
    echo "    QEMU amd64 emulation enabled ✓"
  else
    echo "    ERROR: Could not install QEMU binfmt emulation."
    echo "    Run manually: docker run --privileged --rm tonistiigi/binfmt --install all"
    echo "    Then re-run this script."
    exit 1
  fi
else
  echo "    amd64 native — no emulation needed ✓"
fi

# ── Stop any existing containers ─────────────────────────────────────────────
echo ""
echo "==> Starting containers..."
docker compose down --remove-orphans -v 2>/dev/null || true
docker compose up -d

# ── Wait for health ──────────────────────────────────────────────────────────
echo ""
echo "==> Waiting for Identity Server to be ready..."
MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  if curl -sk -o /dev/null -w "%{http_code}" "https://localhost:${IDS_PORT}/.well-known/openid-configuration" 2>/dev/null | grep -q "200"; then
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo "    WARNING: Server did not become ready within ${MAX_WAIT}s."
  echo ""
  echo "==> Duende container status:"
  docker ps -a --filter "name=devpilot-duende" --format "    Status: {{.Status}}"
  echo ""
  echo "==> Last 20 lines of Duende logs:"
  docker logs devpilot-duende --tail 20 2>&1 | sed 's/^/    /'
  echo ""
  echo "    Fix any issues above and re-run: ./install.sh --no-certs"
else
  echo "    Identity Server is ready ✓"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "  DevPilot Identity Server is running!"
echo ""
echo "  Admin UI       : https://localhost:${IDS_PORT}"
echo "  OIDC Discovery : https://localhost:${IDS_PORT}/.well-known/openid-configuration"
echo ""
echo "  Admin login"
echo "    Username : ${ADMIN_USERNAME}"
echo "    Password : ${ADMIN_PASSWORD}"
echo ""
echo "  OIDC Client ID : devpilot-spa"
echo ""
if [ "$TRUST_CERT" = false ]; then
  echo "  NOTE: The self-signed certificate is NOT trusted by your OS."
  echo "  Your browser will show a warning. To trust it, re-run with:"
  echo "    ./install.sh --no-certs --trust-cert"
  echo ""
fi
echo "══════════════════════════════════════════════════════════════════"
