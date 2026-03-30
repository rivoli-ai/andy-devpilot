#!/bin/bash
#
# DevPilot Sandbox Host - VPS Setup Script
# Creates a Docker-in-Docker host that spawns isolated desktop containers
#
# Run: curl -sSL <url> | sudo bash
#
# Version: 2.1.0 - Fixed Zed launch (no script wrapper, USER sandbox)
SETUP_VERSION="2.2.0"

set -e

echo "=========================================="
echo "DevPilot Sandbox Host - Setup v${SETUP_VERSION}"
echo "=========================================="

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_skip() { echo -e "${BLUE}[SKIP]${NC} $1"; }

# Detect OS
IS_MACOS=false
IS_LINUX=false
if [[ "$OSTYPE" == "darwin"* ]]; then
    IS_MACOS=true
    log_info "Detected macOS - running in local mode (no systemd)"
    PROJECT_DIR="$HOME/.devpilot-sandbox"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    IS_LINUX=true
    PROJECT_DIR="/opt/devpilot-sandbox"
fi

# Resolve script location for certs (before any cd). When run as ./setup.sh from repo, certs are read from <repo>/infra/sandbox/certs.
if [ -n "${BASH_SOURCE[0]}" ] && [ "${BASH_SOURCE[0]}" != "bash" ]; then
    _SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
    [ -n "$_SCRIPT_DIR" ] && SCRIPT_SOURCE_DIR="$_SCRIPT_DIR"
fi

# Check root (only on Linux)
if [ "$IS_LINUX" = true ] && [ "$EUID" -ne 0 ]; then 
    log_error "Please run as root: sudo ./setup.sh"
    exit 1
fi

# ============================================================
# FULL CLEANUP - Remove everything and start fresh
# Skipped in BUILD_ONLY mode (Windows) — only the image build is needed.
# ============================================================
if [ "${BUILD_ONLY:-0}" = "1" ]; then
    log_info "BUILD_ONLY mode — skipping cleanup of existing containers/images."
else
    log_info "Starting full cleanup..."

    # Stop and disable the systemd service (Linux only)
    if [ "$IS_LINUX" = true ]; then
        log_info "Stopping DevPilot service..."
        systemctl stop devpilot-sandbox 2>/dev/null || true
        systemctl disable devpilot-sandbox 2>/dev/null || true
        rm -f /etc/systemd/system/devpilot-sandbox.service 2>/dev/null || true
        systemctl daemon-reload 2>/dev/null || true
    else
        log_info "Stopping any running manager process..."
        pkill -f "manager.py" 2>/dev/null || true
    fi

    # Stop and remove all sandbox containers
    log_info "Removing all sandbox containers..."
    docker ps -q --filter "name=sandbox-" 2>/dev/null | xargs docker stop 2>/dev/null || true
    docker ps -aq --filter "name=sandbox-" 2>/dev/null | xargs docker rm -f 2>/dev/null || true

    # Remove the devpilot-desktop image
    log_info "Removing devpilot-desktop Docker image..."
    docker rmi devpilot-desktop 2>/dev/null || true

    # Remove unused Docker volumes
    log_info "Cleaning up Docker volumes..."
    docker volume prune -f 2>/dev/null || true

    # Remove the project directory and recreate
    # PROJECT_DIR is already set based on OS detection
    log_info "Removing old project directory: $PROJECT_DIR"
    rm -rf "$PROJECT_DIR"

    log_info "Cleanup complete!"
fi
echo ""

# ============================================================
# FRESH INSTALLATION
# ============================================================

# Install Docker
if ! command -v docker &> /dev/null; then
    log_info "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
fi

# Create project directory
PROJECT_DIR="/opt/devpilot-sandbox"
log_info "Creating project: $PROJECT_DIR"
mkdir -p $PROJECT_DIR
cd $PROJECT_DIR

# ============================================================
# Create Desktop Dockerfile (the actual sandbox environment)
# ============================================================
log_info "Creating desktop image..."
mkdir -p desktop

# ── Custom certificates ──────────────────────────────────────────────────
# Centralized: all certs live in <repo-root>/certs/.
# CERTS_DIR env var (set by start.ps1 on Windows) takes priority,
# otherwise resolve two levels up from infra/sandbox/ to reach repo root.
SCRIPT_SOURCE_DIR="${SCRIPT_SOURCE_DIR:-$PROJECT_DIR}"
if [ -n "${CERTS_DIR:-}" ]; then
    CERTS_SOURCE="$CERTS_DIR"
elif [ -d "${SCRIPT_SOURCE_DIR}/../../certs" ]; then
    CERTS_SOURCE="$(cd "${SCRIPT_SOURCE_DIR}/../.." 2>/dev/null && pwd)/certs"
else
    CERTS_SOURCE="${SCRIPT_SOURCE_DIR}/certs"
fi
CERTS_BUILD="desktop/certs"
mkdir -p "$CERTS_BUILD"

CERT_COUNT=0
if [ -d "$CERTS_SOURCE" ]; then
    for f in "$CERTS_SOURCE"/*.crt "$CERTS_SOURCE"/*.pem "$CERTS_SOURCE"/*.cer; do
        [ -f "$f" ] || continue
        cp "$f" "$CERTS_BUILD/"
        CERT_COUNT=$((CERT_COUNT + 1))
        log_info "  Found custom certificate: $(basename "$f")"
    done
fi

if [ "$CERT_COUNT" -gt 0 ]; then
    log_info "Loaded $CERT_COUNT custom certificate(s) from $CERTS_SOURCE"
else
    log_warn "No custom certificates found in $CERTS_SOURCE"
    log_warn "If you're behind a corporate proxy (Zscaler, etc.), place your"
    log_warn "root CA .crt files in: <repo-root>/certs/"
    log_warn "Then re-run this script."
    # Create an empty placeholder so COPY doesn't fail
    touch "$CERTS_BUILD/.keep"
fi

# Create Zed installation script - download directly like Firefox (no install script)
cat > desktop/install-zed.sh << 'INSTALL_ZED_SCRIPT'
#!/bin/bash
# Direct download approach - same as Firefox installation

echo ""
echo "############################################"
echo "#     ZED DIRECT INSTALLATION             #"
echo "############################################"
echo ""

ARCH=$(uname -m)
echo "[ZED] Architecture: $ARCH"
echo "[ZED] User: $(whoami)"
echo "[ZED] Home: $HOME"

# Create directories
mkdir -p /home/sandbox/.local/bin
mkdir -p /home/sandbox/.local/zed.app

# Determine download URL based on architecture
if [ "$ARCH" = "x86_64" ]; then
    ZED_URL="https://zed.dev/api/releases/stable/latest/zed-linux-x86_64.tar.gz"
    echo "[ZED] Using x86_64 download URL"
elif [ "$ARCH" = "aarch64" ]; then
    ZED_URL="https://zed.dev/api/releases/stable/latest/zed-linux-aarch64.tar.gz"
    echo "[ZED] Using aarch64 download URL"
else
    echo "[ZED] ERROR: Unsupported architecture: $ARCH"
    echo "[ZED] Creating placeholder..."
    cat > /home/sandbox/.local/bin/zed << 'PLACEHOLDER'
#!/bin/bash
echo "Zed is not available for architecture: $(uname -m)"
PLACEHOLDER
    chmod +x /home/sandbox/.local/bin/zed
    exit 0
fi

echo "[ZED] Download URL: $ZED_URL"
echo ""

# Download Zed tarball - same pattern as Firefox
echo "[ZED] Downloading Zed (Firefox-style fallback: curl || curl -k || wget)..."
(curl -fsSL --retry 3 --retry-delay 5 "$ZED_URL" -o /tmp/zed.tar.gz || \
 curl -fsSL --retry 3 --retry-delay 5 -k "$ZED_URL" -o /tmp/zed.tar.gz || \
 wget --no-check-certificate -q -O /tmp/zed.tar.gz "$ZED_URL")

# Check if download succeeded
if [ ! -f /tmp/zed.tar.gz ] || [ ! -s /tmp/zed.tar.gz ]; then
    echo "[ZED] ERROR: Download failed!"
    echo "[ZED] Creating placeholder..."
    cat > /home/sandbox/.local/bin/zed << 'PLACEHOLDER'
#!/bin/bash
echo "Zed download failed (SSL/network issue)"
echo "Try manually: curl -k https://zed.dev/api/releases/stable/latest/zed-linux-x86_64.tar.gz -o zed.tar.gz"
PLACEHOLDER
    chmod +x /home/sandbox/.local/bin/zed
    exit 0
fi

echo "[ZED] Download successful: $(ls -lh /tmp/zed.tar.gz | awk '{print $5}')"
echo ""

# Extract Zed
echo "[ZED] Extracting to /home/sandbox/.local/zed.app/..."
tar -xzf /tmp/zed.tar.gz -C /home/sandbox/.local/zed.app/ --strip-components=1

# Check extraction
if [ ! -d /home/sandbox/.local/zed.app ]; then
    echo "[ZED] ERROR: Extraction failed!"
    exit 1
fi

echo "[ZED] Extracted files:"
ls -la /home/sandbox/.local/zed.app/

# Find and symlink the zed binary
ZED_BIN=""
if [ -f /home/sandbox/.local/zed.app/bin/zed ]; then
    ZED_BIN="/home/sandbox/.local/zed.app/bin/zed"
elif [ -f /home/sandbox/.local/zed.app/zed ]; then
    ZED_BIN="/home/sandbox/.local/zed.app/zed"
elif [ -f /home/sandbox/.local/zed.app/libexec/zed-editor ]; then
    ZED_BIN="/home/sandbox/.local/zed.app/libexec/zed-editor"
fi

if [ -n "$ZED_BIN" ]; then
    echo "[ZED] Found binary at: $ZED_BIN"
    ln -sf "$ZED_BIN" /home/sandbox/.local/bin/zed
    chmod +x /home/sandbox/.local/bin/zed
    echo "[ZED] Symlinked to /home/sandbox/.local/bin/zed"
    echo ""
    echo "[ZED] Testing zed --version:"
    /home/sandbox/.local/bin/zed --version 2>&1 || echo "[ZED] Version check failed (may need display)"
    echo ""
    echo "############################################"
    echo "#     ZED INSTALLATION SUCCESS!           #"
    echo "############################################"
else
    echo "[ZED] ERROR: Could not find zed binary after extraction"
    echo "[ZED] Contents of zed.app:"
    find /home/sandbox/.local/zed.app -type f | head -20
    echo ""
    echo "[ZED] Creating placeholder..."
    cat > /home/sandbox/.local/bin/zed << 'PLACEHOLDER'
#!/bin/bash
echo "Zed binary not found after extraction"
echo "Check /home/sandbox/.local/zed.app/"
PLACEHOLDER
    chmod +x /home/sandbox/.local/bin/zed
fi

# Cleanup
rm -f /tmp/zed.tar.gz

echo ""
echo "############################################"
echo "#     ZED SETUP COMPLETE                  #"
echo "############################################"
echo ""
INSTALL_ZED_SCRIPT

cat > desktop/Dockerfile << 'DESKTOP_DOCKERFILE'
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:0
ENV RESOLUTION=1920x1080x24

# Clean up any broken/outdated third-party repositories that might cause apt errors
RUN rm -f /etc/apt/sources.list.d/azlux.list 2>/dev/null || true && \
    rm -f /etc/apt/sources.list.d/log2ram.list 2>/dev/null || true

# Install desktop environment + nginx for iframe proxy + software rendering + xdotool for automation
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify nginx \
    xfce4 xfce4-terminal xterm screen thunar mousepad \
    xterm screen \
    sudo wget curl git ca-certificates openssl unzip \
    python3 python3-pip python3-venv dbus-x11 \
    fonts-dejavu fonts-liberation \
    libxkbcommon0 libvulkan1 libasound2t64 libgbm1 \
    mesa-utils libgl1-mesa-dri libegl1 libgles2 \
    mesa-vulkan-drivers \
    xdotool wmctrl xclip xsel autocutsel \
    xdg-desktop-portal xdg-desktop-portal-gtk \
    xdg-utils bzip2 xz-utils \
    gnome-keyring libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*

# Inject automatic clipboard sync into noVNC:
# - Host→Sandbox: on Ctrl+V/focus/click, read browser clipboard and push to VNC clipboard textarea
# - Sandbox→Host: poll VNC clipboard textarea, write to browser clipboard
RUN printf '%s\n' \
  '(function(){' \
  ' var last="",lastPush="";' \
  ' function ta(){return document.getElementById("noVNC_clipboard_text")}' \
  ' function pushToVnc(text){' \
  '  var el=ta();if(!el||!text||text===lastPush)return;' \
  '  lastPush=text;el.value=text;el.dispatchEvent(new Event("change"));' \
  ' }' \
  ' function readAndPush(){' \
  '  if(navigator.clipboard&&navigator.clipboard.readText)' \
  '   navigator.clipboard.readText().then(function(t){pushToVnc(t);}).catch(function(){});' \
  ' }' \
  ' document.addEventListener("keydown",function(e){' \
  '  if((e.ctrlKey||e.metaKey)&&e.key==="v")readAndPush();' \
  ' },true);' \
  ' document.addEventListener("paste",function(e){' \
  '  var t=(e.clipboardData||window.clipboardData).getData("text");' \
  '  if(t)pushToVnc(t);' \
  ' });' \
  ' window.addEventListener("focus",function(){readAndPush();});' \
  ' document.addEventListener("click",function(){readAndPush();});' \
  ' setInterval(function(){' \
  '  var el=ta();if(!el)return;' \
  '  if(el.value!==last){last=el.value;' \
  '   if(navigator.clipboard&&navigator.clipboard.writeText)' \
  '    navigator.clipboard.writeText(el.value).catch(function(){});}' \
  ' },500);' \
  '})();' > /usr/share/novnc/clipboard-sync.js && \
    sed -i '/<\/body>/i <script src="clipboard-sync.js"><\/script>' /usr/share/novnc/vnc.html && \
    sed -i '/<\/head>/i <style>#noVNC_control_bar_anchor{display:none!important;}</style>' /usr/share/novnc/vnc.html

# ── SSL certificates (build-time) ──
# Custom certificates (Zscaler, corporate proxy, etc.) are loaded from the
# sandbox/certs/ folder. Users place their .crt/.pem files there BEFORE building.
# The setup script copies them into the Docker build context automatically.
COPY certs/ /usr/local/share/ca-certificates/custom/
RUN find /usr/local/share/ca-certificates/custom/ -name '.keep' -delete 2>/dev/null || true && \
    update-ca-certificates

# Extract LIVE certificate chains from actual servers using openssl s_client.
# Splits each cert into its OWN file so c_rehash indexes ALL of them.
# This catches any intermediate/root CAs that the corporate proxy injects.
RUN for HOST in api.nuget.org globalcdn.nuget.org nuget.org registry.npmjs.org; do \
        echo | openssl s_client -showcerts -connect ${HOST}:443 -servername ${HOST} 2>/dev/null | \
            awk -v host=${HOST} \
                'BEGIN{n=0} /BEGIN CERTIFICATE/{n++; fname="/usr/local/share/ca-certificates/live-"host"-"n".crt"} \
                 /BEGIN CERTIFICATE/,/END CERTIFICATE/{print > fname}' 2>/dev/null; \
    done && \
    update-ca-certificates && \
    c_rehash /etc/ssl/certs 2>/dev/null || true

# ── Temporary SSL bypass for install scripts ──
# dotnet-install.sh and NodeSource's setup script call curl/wget internally;
# we make ALL curl/wget calls skip SSL verification during these installs,
# same approach as Firefox and Zed (handle broken/missing certs in Docker).
RUN echo 'insecure' > /root/.curlrc && \
    echo 'check_certificate = off' > /root/.wgetrc

# Install .NET SDK 8, 9, and 10 via dotnet-install.sh (works for all versions)
RUN (curl -fsSL --retry 3 --retry-delay 5 https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh || \
     wget -q -O /tmp/dotnet-install.sh https://dot.net/v1/dotnet-install.sh) && \
    chmod +x /tmp/dotnet-install.sh && \
    /tmp/dotnet-install.sh --channel 8.0 --install-dir /usr/share/dotnet && \
    /tmp/dotnet-install.sh --channel 9.0 --install-dir /usr/share/dotnet && \
    /tmp/dotnet-install.sh --channel 10.0 --quality preview --install-dir /usr/share/dotnet && \
    rm -f /tmp/dotnet-install.sh && \
    ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet
ENV DOTNET_ROOT=/usr/share/dotnet
ENV PATH="${DOTNET_ROOT}:${PATH}"

# Install Node.js + npm directly from official tarball (same pattern as Firefox/Zed)
# Avoids NodeSource setup script which can fail with SSL issues in Docker
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then NODE_ARCH="arm64"; else NODE_ARCH="x64"; fi && \
    NODE_VERSION="22.13.1" && \
    NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" && \
    (curl -fsSL --retry 3 --retry-delay 5 "$NODE_URL" -o /tmp/node.tar.xz || \
     curl -fsSL --retry 3 --retry-delay 5 -k "$NODE_URL" -o /tmp/node.tar.xz || \
     wget --no-check-certificate -q -O /tmp/node.tar.xz "$NODE_URL") && \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && \
    rm -f /tmp/node.tar.xz && \
    node --version && npm --version

# ── Remove temporary SSL bypass ──
RUN rm -f /root/.curlrc /root/.wgetrc

# SSL environment variables for various applications
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/certs
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
# Disable SSL verification for sandbox (development environment)
ENV SSL_VERIFY=false
ENV GIT_SSL_NO_VERIFY=true
ENV PYTHONHTTPSVERIFY=0
# .NET / NuGet SSL bypass
ENV DOTNET_SYSTEM_NET_HTTP_USESOCKETSHTTPHANDLER=0
ENV NUGET_CERT_REVOCATION_MODE=off
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NUGET_SIGNATURE_VERIFICATION=false
# npm: disable strict SSL validation
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
ENV NPM_CONFIG_STRICT_SSL=false

# Install Firefox directly from Mozilla (Ubuntu snap packages don't work in Docker)
# Uses retry and fallback to handle SSL/network issues
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
        FF_URL="https://download.mozilla.org/?product=firefox-latest&os=linux64-aarch64&lang=en-US"; \
    else \
        FF_URL="https://download.mozilla.org/?product=firefox-latest&os=linux64&lang=en-US"; \
    fi && \
    (curl -fsSL --retry 3 --retry-delay 5 "$FF_URL" -o /tmp/firefox.tar.xz || \
     curl -fsSL --retry 3 --retry-delay 5 -k "$FF_URL" -o /tmp/firefox.tar.xz || \
     wget --no-check-certificate -q -O /tmp/firefox.tar.xz "$FF_URL") && \
    tar -xJf /tmp/firefox.tar.xz -C /opt/ && \
    ln -sf /opt/firefox/firefox /usr/local/bin/firefox && \
    rm /tmp/firefox.tar.xz

# Create Firefox desktop file with --no-sandbox flag (required for Docker)
RUN echo '[Desktop Entry]\n\
Name=Firefox\n\
Comment=Web Browser\n\
Exec=/opt/firefox/firefox --no-sandbox %u\n\
Terminal=false\n\
Type=Application\n\
Icon=/opt/firefox/browser/chrome/icons/default/default128.png\n\
Categories=Network;WebBrowser;\n\
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;\n\
StartupWMClass=firefox' > /usr/share/applications/firefox.desktop

# Install Python packages for ACP agent and bridge API in a virtual environment
# Use trusted-host to bypass SSL certificate issues
RUN python3 -m venv /opt/devpilot-venv && \
    /opt/devpilot-venv/bin/pip install --upgrade pip \
        --trusted-host pypi.org \
        --trusted-host files.pythonhosted.org && \
    /opt/devpilot-venv/bin/pip install \
        --trusted-host pypi.org \
        --trusted-host files.pythonhosted.org \
        agent-client-protocol \
        openai \
        flask \
        flask-cors \
        requests

# Add venv to PATH
ENV PATH="/opt/devpilot-venv/bin:$PATH"

# Remove screen locker
RUN apt-get update && apt-get remove -y xfce4-screensaver light-locker 2>/dev/null || true \
    && rm -rf /var/lib/apt/lists/*

# Create sandbox user
RUN useradd -m -s /bin/bash sandbox && \
    echo "sandbox ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Write SSL bypass + env vars to sandbox user's .bashrc so EVERY terminal session gets them
RUN echo '# SSL bypass for sandbox (dev environment)' >> /home/sandbox/.bashrc && \
    echo 'export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt' >> /home/sandbox/.bashrc && \
    echo 'export SSL_CERT_DIR=/etc/ssl/certs' >> /home/sandbox/.bashrc && \
    echo 'export DOTNET_SYSTEM_NET_HTTP_USESOCKETSHTTPHANDLER=0' >> /home/sandbox/.bashrc && \
    echo 'export NUGET_CERT_REVOCATION_MODE=off' >> /home/sandbox/.bashrc && \
    echo 'export DOTNET_NUGET_SIGNATURE_VERIFICATION=false' >> /home/sandbox/.bashrc && \
    echo 'export NODE_TLS_REJECT_UNAUTHORIZED=0' >> /home/sandbox/.bashrc && \
    echo 'export GIT_SSL_NO_VERIFY=true' >> /home/sandbox/.bashrc && \
    chown sandbox:sandbox /home/sandbox/.bashrc

# Create fix-ssl helper script (user can type "fix-ssl" in terminal if SSL issues persist)
# Re-extracts live certs from servers and updates the trust store
RUN cat > /usr/local/bin/fix-ssl << 'FIX_SSL_SCRIPT'
#!/bin/bash
echo "==> Extracting live SSL certs from servers..."
for H in api.nuget.org globalcdn.nuget.org nuget.org registry.npmjs.org; do
  echo | openssl s_client -showcerts -connect $H:443 -servername $H 2>/dev/null | \
    awk -v h=$H 'BEGIN{n=0}/BEGIN CERT/{n++;f="/tmp/c-"h"-"n".pem"}/BEGIN CERT/,/END CERT/{print>f}' 2>/dev/null
  for F in /tmp/c-$H-*.pem; do
    [ -f "$F" ] && sudo cp "$F" /usr/local/share/ca-certificates/$(basename $F .pem).crt && rm -f "$F"
  done
  echo "  $H: done"
done
echo ""
echo "==> Updating trust store..."
sudo update-ca-certificates 2>/dev/null
sudo c_rehash /etc/ssl/certs 2>/dev/null
echo ""
echo "Done. Try 'dotnet restore' again."
echo ""
echo "TIP: If this keeps failing, export your corporate root CA (Zscaler, etc.)"
echo "     and place it in sandbox/certs/ then re-run setup.sh"
FIX_SSL_SCRIPT
RUN chmod +x /usr/local/bin/fix-ssl

# Configure nginx for noVNC proxy (port 6080)
RUN echo 'server {' > /etc/nginx/sites-available/novnc && \
    echo '    listen 6080;' >> /etc/nginx/sites-available/novnc && \
    echo '    location / {' >> /etc/nginx/sites-available/novnc && \
    echo '        proxy_pass http://127.0.0.1:6081;' >> /etc/nginx/sites-available/novnc && \
    echo '        proxy_http_version 1.1;' >> /etc/nginx/sites-available/novnc && \
    echo '        proxy_set_header Upgrade $http_upgrade;' >> /etc/nginx/sites-available/novnc && \
    echo '        proxy_set_header Connection "upgrade";' >> /etc/nginx/sites-available/novnc && \
    echo '        proxy_set_header Host $host;' >> /etc/nginx/sites-available/novnc && \
    echo '        proxy_set_header X-Real-IP $remote_addr;' >> /etc/nginx/sites-available/novnc && \
    echo '        proxy_hide_header X-Frame-Options;' >> /etc/nginx/sites-available/novnc && \
    echo '        proxy_hide_header Content-Security-Policy;' >> /etc/nginx/sites-available/novnc && \
    echo '        proxy_hide_header X-Content-Type-Options;' >> /etc/nginx/sites-available/novnc && \
    echo '        add_header Access-Control-Allow-Origin "*" always;' >> /etc/nginx/sites-available/novnc && \
    echo '        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;' >> /etc/nginx/sites-available/novnc && \
    echo '        add_header Access-Control-Allow-Headers "*" always;' >> /etc/nginx/sites-available/novnc && \
    echo '        add_header Permissions-Policy "clipboard-read=*, clipboard-write=*" always;' >> /etc/nginx/sites-available/novnc && \
    echo '    }' >> /etc/nginx/sites-available/novnc && \
    echo '    location /api/ {' >> /etc/nginx/sites-available/novnc && \
    echo '        proxy_pass http://127.0.0.1:8091/;' >> /etc/nginx/sites-available/novnc && \
    echo '        proxy_set_header Host $host;' >> /etc/nginx/sites-available/novnc && \
    echo '        proxy_set_header X-Real-IP $remote_addr;' >> /etc/nginx/sites-available/novnc && \
    echo '    }' >> /etc/nginx/sites-available/novnc && \
    echo '}' >> /etc/nginx/sites-available/novnc && \
    ln -sf /etc/nginx/sites-available/novnc /etc/nginx/sites-enabled/novnc && \
    rm -f /etc/nginx/sites-enabled/default

# Copy Zed install script before switching user (for non-BuildKit compatibility)
COPY install-zed.sh /home/sandbox/install-zed.sh
RUN chmod 755 /home/sandbox/install-zed.sh && chown sandbox:sandbox /home/sandbox/install-zed.sh

USER sandbox
WORKDIR /home/sandbox

# Install Zed IDE with architecture check and proper error handling
RUN /home/sandbox/install-zed.sh; rm -f /home/sandbox/install-zed.sh
ENV PATH="/home/sandbox/.local/bin:${PATH}"

# Desktop shortcut
RUN mkdir -p Desktop && \
    echo '[Desktop Entry]' > Desktop/zed.desktop && \
    echo 'Type=Application' >> Desktop/zed.desktop && \
    echo 'Name=Zed' >> Desktop/zed.desktop && \
    echo 'Exec=/home/sandbox/.local/bin/zed' >> Desktop/zed.desktop && \
    echo 'Terminal=false' >> Desktop/zed.desktop && \
    chmod +x Desktop/zed.desktop

USER root

# Copy DevPilot ACP agent and bridge API
COPY devpilot-agent.py /opt/devpilot/devpilot-agent.py
COPY devpilot-bridge.py /opt/devpilot/devpilot-bridge.py
RUN chmod +x /opt/devpilot/*.py

# Startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Run as sandbox user (Zed refuses to run as root)
# nginx is started via sudo inside start.sh
USER sandbox
EXPOSE 6080 8091

CMD ["/start.sh"]
DESKTOP_DOCKERFILE

# ============================================================
# Create DevPilot ACP Agent (communicates with Zed via ACP)
# ============================================================
log_info "Creating DevPilot ACP agent..."
cat > desktop/devpilot-agent.py << 'DEVPILOT_AGENT'
#!/usr/bin/env python3
"""
DevPilot ACP Agent - Custom agent for Zed that uses OpenAI-compatible APIs
Communicates with Zed via Agent Client Protocol (ACP) over stdio
"""
import os
import sys
import json
import asyncio
import logging
from typing import Optional

# Configure logging to file (not stdout, as that's used for ACP)
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[logging.FileHandler('/tmp/devpilot-agent.log')]
)
logger = logging.getLogger(__name__)

try:
    from openai import OpenAI
except ImportError:
    logger.error("OpenAI package not installed")
    sys.exit(1)

class DevPilotAgent:
    """Custom ACP agent that uses OpenAI-compatible API"""
    
    def __init__(self):
        self.api_key = os.environ.get('OPENAI_API_KEY', '')
        self.api_base = os.environ.get('OPENAI_API_BASE', 'https://api.openai.com/v1')
        self.model = os.environ.get('DEVPILOT_MODEL', 'gpt-4o')
        self.project_path = os.environ.get('DEVPILOT_PROJECT_PATH', '/home/sandbox/projects')
        
        logger.info(f"Initializing DevPilot Agent")
        logger.info(f"API Base: {self.api_base}")
        logger.info(f"Model: {self.model}")
        logger.info(f"Project Path: {self.project_path}")
        
        # Initialize OpenAI client
        self.client = OpenAI(
            api_key=self.api_key,
            base_url=self.api_base
        ) if self.api_key else None
        
        self.session_id = None
        self.conversation_history = []
    
    async def read_message(self) -> Optional[dict]:
        """Read a JSON-RPC message from stdin"""
        try:
            line = await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)
            if not line:
                return None
            logger.debug(f"Received: {line.strip()}")
            return json.loads(line)
        except json.JSONDecodeError as e:
            logger.error(f"JSON decode error: {e}")
            return None
    
    def send_message(self, message: dict):
        """Send a JSON-RPC message to stdout"""
        msg_str = json.dumps(message)
        logger.debug(f"Sending: {msg_str}")
        print(msg_str, flush=True)
    
    def send_response(self, id: int, result: dict):
        """Send a JSON-RPC response"""
        self.send_message({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        })
    
    def send_error(self, id: int, code: int, message: str):
        """Send a JSON-RPC error response"""
        self.send_message({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": code, "message": message}
        })
    
    def send_notification(self, method: str, params: dict):
        """Send a JSON-RPC notification (no id, no response expected)"""
        self.send_message({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        })
    
    def get_project_context(self) -> str:
        """Get basic project context for the AI"""
        context_parts = []
        
        # Check for common project files
        project_files = [
            ('README.md', 'Project README'),
            ('package.json', 'Node.js package config'),
            ('requirements.txt', 'Python requirements'),
            ('pom.xml', 'Maven config'),
            ('build.gradle', 'Gradle config'),
            ('Cargo.toml', 'Rust config'),
            ('go.mod', 'Go module config'),
        ]
        
        for filename, description in project_files:
            filepath = os.path.join(self.project_path, filename)
            if os.path.exists(filepath):
                try:
                    with open(filepath, 'r') as f:
                        content = f.read()[:2000]  # Limit to 2000 chars
                    context_parts.append(f"### {description} ({filename}):\n```\n{content}\n```")
                except Exception as e:
                    logger.error(f"Error reading {filepath}: {e}")
        
        # List top-level files and directories
        try:
            items = os.listdir(self.project_path)
            context_parts.append(f"### Project structure:\n{', '.join(items[:30])}")
        except Exception as e:
            logger.error(f"Error listing project: {e}")
        
        return "\n\n".join(context_parts) if context_parts else "No project context available"
    
    async def handle_initialize(self, id: int, params: dict):
        """Handle initialize request"""
        logger.info("Handling initialize request")
        self.send_response(id, {
            "protocol_version": 1,
            "capabilities": {
                "streaming": True,
                "tools": False
            },
            "agent_info": {
                "name": "DevPilot",
                "version": "1.0.0",
                "description": "AI-powered code analysis agent"
            }
        })
    
    async def handle_session_start(self, id: int, params: dict):
        """Handle session/start request"""
        self.session_id = params.get("session_id", "default")
        logger.info(f"Session started: {self.session_id}")
        self.conversation_history = []
        self.send_response(id, {"session_id": self.session_id})
    
    async def handle_prompt(self, id: int, params: dict):
        """Handle prompt/turn request - main entry point for user messages"""
        logger.info(f"Handling prompt: {params}")
        
        if not self.client:
            self.send_error(id, -32000, "OpenAI API not configured. Please set OPENAI_API_KEY.")
            return
        
        # Extract user message from prompt content
        content_blocks = params.get("content", [])
        user_message = ""
        for block in content_blocks:
            if block.get("type") == "text":
                user_message += block.get("text", "")
        
        if not user_message:
            self.send_error(id, -32602, "No message content provided")
            return
        
        # Build messages with project context
        system_prompt = f"""You are DevPilot, an AI coding assistant integrated into the Zed editor.
You are analyzing a project located at: {self.project_path}

{self.get_project_context()}

Help the user understand, improve, and work with this codebase. Be concise and actionable."""
        
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(self.conversation_history)
        messages.append({"role": "user", "content": user_message})
        
        try:
            # Stream response
            logger.info(f"Calling API with model: {self.model}")
            response = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                stream=True,
                max_tokens=4096
            )
            
            full_response = ""
            for chunk in response:
                if chunk.choices and chunk.choices[0].delta.content:
                    delta = chunk.choices[0].delta.content
                    full_response += delta
                    
                    # Send streaming update
                    self.send_notification("session/update", {
                        "session_id": self.session_id,
                        "content": [{"type": "text", "text": delta}]
                    })
            
            # Store in conversation history
            self.conversation_history.append({"role": "user", "content": user_message})
            self.conversation_history.append({"role": "assistant", "content": full_response})
            
            # Send final response
            self.send_response(id, {
                "stop_reason": "end_turn",
                "content": [{"type": "text", "text": full_response}]
            })
            
            # Also write to bridge file for frontend access
            self._write_to_bridge(user_message, full_response)
            
        except Exception as e:
            logger.error(f"API error: {e}")
            self.send_error(id, -32000, f"API error: {str(e)}")
    
    def _write_to_bridge(self, prompt: str, response: str):
        """Write conversation to bridge file for frontend access"""
        try:
            import uuid
            import time
            
            bridge_file = "/tmp/devpilot-acp-conversations.json"
            
            # Load existing conversations
            conversations = []
            if os.path.exists(bridge_file):
                try:
                    with open(bridge_file, 'r') as f:
                        data = json.load(f)
                        conversations = data.get("conversations", [])
                except:
                    pass
            
            # Add new conversation
            conversation = {
                "id": str(uuid.uuid4()),
                "timestamp": time.time(),
                "user_message": prompt,
                "assistant_message": response,
                "model": self.model,
                "source": "acp_agent"
            }
            conversations.append(conversation)
            
            # Keep only last 50 conversations
            if len(conversations) > 50:
                conversations = conversations[-50:]
            
            # Write back
            with open(bridge_file, 'w') as f:
                json.dump({"conversations": conversations, "count": len(conversations)}, f)
            
            logger.info(f"Conversation saved to bridge. Total: {len(conversations)}")
        except Exception as e:
            logger.error(f"Error writing to bridge: {e}")
    
    async def run(self):
        """Main event loop"""
        logger.info("DevPilot Agent started")
        
        while True:
            message = await self.read_message()
            if message is None:
                logger.info("EOF received, shutting down")
                break
            
            method = message.get("method")
            id = message.get("id")
            params = message.get("params", {})
            
            logger.info(f"Received method: {method}")
            
            if method == "initialize":
                await self.handle_initialize(id, params)
            elif method == "session/start":
                await self.handle_session_start(id, params)
            elif method == "prompt/turn":
                await self.handle_prompt(id, params)
            elif method == "shutdown":
                logger.info("Shutdown requested")
                self.send_response(id, {})
                break
            else:
                logger.warning(f"Unknown method: {method}")
                if id is not None:
                    self.send_error(id, -32601, f"Method not found: {method}")

if __name__ == "__main__":
    agent = DevPilotAgent()
    asyncio.run(agent.run())
DEVPILOT_AGENT

# ============================================================
# Create DevPilot Bridge API (HTTP API for frontend communication)
# ============================================================
log_info "Creating DevPilot Bridge API..."
cat > desktop/devpilot-bridge.py << 'DEVPILOT_BRIDGE'
#!/usr/bin/env python3
"""
DevPilot Bridge API - HTTP API for frontend to communicate with sandbox
Exposes endpoints to:
- Send prompts to the AI (via OpenAI-compatible API)
- Get conversation history
- Trigger Zed actions via xdotool
"""
import os
import sys
import json
import subprocess
import logging
from flask import Flask, request, jsonify
from flask_cors import CORS

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/devpilot-bridge.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*", "allow_headers": ["Authorization", "Content-Type"]}})

# Per-sandbox token — injected as SANDBOX_TOKEN env var by the manager at container creation
SANDBOX_TOKEN = os.environ.get('SANDBOX_TOKEN', '')

@app.before_request
def require_token():
    """
    Protect all external-facing routes with the sandbox bearer token.
    Exemptions:
    - OPTIONS requests: CORS preflight — browsers never send auth headers here
    - /v1/* routes: OpenAI proxy called by Zed from inside the container on localhost
    """
    if not SANDBOX_TOKEN:
        return  # Auth disabled when no token configured
    if request.method == 'OPTIONS':
        return  # Let Flask-CORS handle preflight freely
    if request.path.startswith('/v1/'):
        return  # Zed internal calls — no auth header available
    auth = request.headers.get('Authorization', '')
    if auth != f'Bearer {SANDBOX_TOKEN}':
        return jsonify({'error': 'Unauthorized'}), 401

# SSL Configuration - try to fix SSL issues in sandbox
SSL_CERT_FILE = os.environ.get('SSL_CERT_FILE', '/etc/ssl/certs/ca-certificates.crt')
SSL_VERIFY = os.environ.get('SSL_VERIFY', 'true').lower() != 'false'

# Log SSL configuration at startup
logger.info(f"=== SSL CONFIGURATION ===")
logger.info(f"SSL_CERT_FILE: {SSL_CERT_FILE}")
logger.info(f"SSL_VERIFY: {SSL_VERIFY}")
logger.info(f"CA file exists: {os.path.exists(SSL_CERT_FILE) if SSL_CERT_FILE else False}")

# Determine SSL verify parameter for requests
if not SSL_VERIFY:
    REQUESTS_SSL_VERIFY = False
    logger.warning("SSL verification DISABLED - not recommended for production")
elif os.path.exists(SSL_CERT_FILE):
    REQUESTS_SSL_VERIFY = SSL_CERT_FILE
    logger.info(f"Using CA bundle: {SSL_CERT_FILE}")
else:
    REQUESTS_SSL_VERIFY = True
    logger.info("Using system default SSL verification")

# Suppress SSL warnings if verification is disabled
if not SSL_VERIFY:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Configuration from environment
API_KEY = os.environ.get('OPENAI_API_KEY', '')
API_BASE = os.environ.get('OPENAI_API_BASE', 'https://api.openai.com/v1')
MODEL = os.environ.get('DEVPILOT_MODEL', 'gpt-4o')
PROJECT_PATH = os.environ.get('DEVPILOT_PROJECT_PATH', '/home/sandbox/projects')

# Conversation history
conversation_history = []

# Track whether the terminal panel has been opened in Zed
_terminal_panel_opened = False

try:
    from openai import OpenAI
    client = OpenAI(api_key=API_KEY, base_url=API_BASE) if API_KEY else None
except ImportError:
    client = None
    logger.error("OpenAI package not installed")

# Store all Zed conversations (for frontend access)
zed_conversations = []

# True while handling a chat/completions request (LLM streaming or processing)
# Frontend uses this to know when implementation is truly done (no 30s guess)
bridge_request_in_progress = False

# Patterns to filter out system/internal Zed messages
SYSTEM_MESSAGE_PATTERNS = [
    "Generate a concise",
    "word title for this conversation",
    "omitting punctuation",
    "You are an expert engineer and your task is to write a new file",
    "The backticks should be on their own line",
    "Tool calls have been disabled",
    "<file_path>",
    "<edit_description>",
]

def is_system_message(user_message):
    """Check if a message is a system/internal Zed message that should be filtered"""
    if not user_message:
        return False
    msg_lower = user_message.lower()
    for pattern in SYSTEM_MESSAGE_PATTERNS:
        if pattern.lower() in msg_lower:
            return True
    return False

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({
        "status": "ok",
        "api_configured": bool(API_KEY),
        "model": MODEL,
        "project_path": PROJECT_PATH
    })

# ============================================================
# OpenAI-Compatible Proxy Endpoint (Zed routes through here)
# This proxy handles the FULL tool execution flow:
# 1. Initial request with tools definitions
# 2. Response may contain tool_calls (passed through to Zed)
# 3. Zed executes tools and sends results back
# 4. Continue until final text response
# ============================================================
@app.route('/v1/chat/completions', methods=['POST'])
def openai_chat_completions():
    """
    OpenAI-compatible chat completions endpoint.
    Zed calls this, we proxy to the LLM and handle tool execution flow.
    
    Tool execution flow:
    - Request contains 'tools' array with tool definitions
    - Response may contain 'tool_calls' in the message
    - Zed executes tools locally and sends results as 'tool' role messages
    - We pass everything through and only capture final text responses
    """
    if not API_KEY:
        return jsonify({"error": {"message": "API not configured", "type": "invalid_request_error"}}), 500
    
    data = request.get_json()
    messages = data.get('messages', [])
    requested_model = data.get('model', '')
    stream = data.get('stream', False)
    
    # IMPORTANT: Always use our configured model, not what Zed sends
    model = MODEL
    
    # Detect if this is a tool result submission (continuing a tool execution)
    has_tool_results = any(msg.get('role') == 'tool' for msg in messages)
    has_tool_calls_in_history = any(
        msg.get('role') == 'assistant' and msg.get('tool_calls') 
        for msg in messages
    )
    has_tools = bool(data.get('tools'))
    
    logger.info(f"=== ZED REQUEST ===")
    logger.info(f"Requested model: {requested_model} -> Using: {model}")
    logger.info(f"Messages count: {len(messages)}")
    logger.info(f"Stream: {stream}")
    logger.info(f"Has tools: {has_tools}, Has tool results: {has_tool_results}, Tool calls in history: {has_tool_calls_in_history}")
    
    # Log ALL messages for debugging (roles and content preview)
    for i, msg in enumerate(messages):
        role = msg.get('role', 'unknown')
        content = msg.get('content', '')
        tool_calls = msg.get('tool_calls')
        tool_call_id = msg.get('tool_call_id')
        
        # Extract text preview
        if isinstance(content, list):
            text_parts = []
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'text':
                    text_parts.append(block.get('text', '')[:100])
            preview = ' '.join(text_parts)[:150]
        elif content:
            preview = str(content)[:150]
        else:
            preview = "(empty)"
        
        extra_info = ""
        if tool_calls:
            tool_names = [tc.get('function', {}).get('name', '?') for tc in tool_calls]
            extra_info = f" [tool_calls: {tool_names}]"
        if tool_call_id:
            extra_info += f" [tool_call_id: {tool_call_id}]"
        
        logger.info(f"  [{i}] {role}: {preview}{extra_info}")
    
    # Extract the LATEST user message for conversation tracking
    # We want the most recent user message, not the first one
    user_message = ""
    for msg in reversed(messages):
        if msg.get('role') == 'user':
            content = msg.get('content', '')
            if isinstance(content, list):
                text_parts = []
                for block in content:
                    if isinstance(block, dict) and block.get('type') == 'text':
                        text_parts.append(block.get('text', ''))
                user_message = ' '.join(text_parts)[:500]
            else:
                user_message = str(content)[:500]
            # Take the LATEST user message (most recent prompt)
            break
    
    logger.info(f"Extracted user message: {user_message[:200] if user_message else '(none)'}...")
    
    global bridge_request_in_progress
    bridge_request_in_progress = True
    try:
        import requests as http_requests
        import time
        import uuid
        
        headers = {
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json"
        }
        
        # Pass through ALL fields from Zed, just override the model
        # This preserves: tools, tool_choice, messages (including tool results), etc.
        payload = dict(data)
        payload["model"] = model
        
        # Log tool-related info
        if payload.get('tools'):
            tool_names = [t.get('function', {}).get('name', 'unknown') for t in payload['tools'][:10]]
            logger.info(f"Tools ({len(payload['tools'])}): {tool_names}...")
        if payload.get('tool_choice'):
            logger.info(f"Tool choice: {payload['tool_choice']}")
        
        if stream:
            # Streaming response with full tool call support
            def generate_stream():
                global bridge_request_in_progress
                full_text_response = ""
                has_tool_calls = False
                tool_calls_buffer = []  # Buffer to collect tool call chunks
                
                try:
                    logger.info(f"Making streaming request to: {API_BASE}/chat/completions")
                    logger.info(f"SSL verify: {REQUESTS_SSL_VERIFY}")
                    response = http_requests.post(
                        f"{API_BASE}/chat/completions",
                        headers=headers,
                        json=payload,
                        timeout=300,  # Longer timeout for tool execution
                        stream=True,
                        verify=REQUESTS_SSL_VERIFY
                    )
                    
                    if response.status_code != 200:
                        logger.error(f"LLM stream error: {response.status_code}")
                        try:
                            error_body = response.text
                            logger.error(f"Error body: {error_body[:500]}")
                        except:
                            pass
                        error_data = {"error": {"message": f"LLM error: {response.status_code}", "type": "api_error"}}
                        yield f"data: {json.dumps(error_data)}\n\n"
                        yield "data: [DONE]\n\n"
                        return
                    
                    for line in response.iter_lines():
                        if line:
                            line_str = line.decode('utf-8')
                            if line_str.startswith('data: '):
                                # Pass through the chunk unchanged to Zed
                                yield line_str + "\n\n"
                                
                                # Parse chunk for logging and conversation tracking
                                try:
                                    if line_str != 'data: [DONE]':
                                        chunk_data = json.loads(line_str[6:])
                                        if chunk_data.get('choices'):
                                            choice = chunk_data['choices'][0]
                                            delta = choice.get('delta', {})
                                            
                                            # Track text content
                                            if delta.get('content'):
                                                full_text_response += delta['content']
                                            
                                            # Track tool calls
                                            if delta.get('tool_calls'):
                                                has_tool_calls = True
                                                for tc in delta['tool_calls']:
                                                    idx = tc.get('index', 0)
                                                    while len(tool_calls_buffer) <= idx:
                                                        tool_calls_buffer.append({
                                                            'id': '',
                                                            'type': 'function',
                                                            'function': {'name': '', 'arguments': ''}
                                                        })
                                                    if tc.get('id'):
                                                        tool_calls_buffer[idx]['id'] = tc['id']
                                                    if tc.get('function', {}).get('name'):
                                                        tool_calls_buffer[idx]['function']['name'] = tc['function']['name']
                                                    if tc.get('function', {}).get('arguments'):
                                                        tool_calls_buffer[idx]['function']['arguments'] += tc['function']['arguments']
                                except Exception as parse_err:
                                    logger.debug(f"Chunk parse error (non-fatal): {parse_err}")
                    
                    yield "data: [DONE]\n\n"
                    
                    # Log what we received
                    if has_tool_calls:
                        tool_names = [tc['function']['name'] for tc in tool_calls_buffer if tc['function']['name']]
                        logger.info(f"=== ZED RESPONSE (stream) - TOOL CALLS ===")
                        logger.info(f"Tool calls: {tool_names}")
                        # Don't store tool call responses - wait for final text
                    elif full_text_response:
                        logger.info(f"=== ZED RESPONSE (stream) - TEXT ===")
                        logger.info(f"Assistant (truncated): {full_text_response[:200]}...")
                        
                        # Only store final text responses (not intermediate tool call responses)
                        # A final response has text and comes after any tool execution
                        # Also filter out system messages (title generation, file writing, etc.)
                        if user_message and full_text_response.strip() and not is_system_message(user_message):
                            conversation_entry = {
                                "id": str(uuid.uuid4()),
                                "timestamp": time.time(),
                                "user_message": user_message,
                                "assistant_message": full_text_response,
                                "model": model,
                                "had_tool_execution": has_tool_results or has_tool_calls_in_history,
                                "source": "proxy"
                            }
                            zed_conversations.append(conversation_entry)
                            if len(zed_conversations) > 50:
                                zed_conversations.pop(0)
                            
                            try:
                                with open('/tmp/zed-latest-conversation.json', 'w') as f:
                                    json.dump(conversation_entry, f)
                            except Exception as e:
                                logger.error(f"Error writing conversation file: {e}")
                        elif is_system_message(user_message):
                            logger.info(f"Filtered system message: {user_message[:50]}...")
                            
                            logger.info(f"Conversation stored. Total: {len(zed_conversations)}")
                    else:
                        logger.info(f"=== ZED RESPONSE (stream) - EMPTY ===")
                    
                except Exception as e:
                    logger.error(f"Stream error: {e}")
                    import traceback
                    logger.error(traceback.format_exc())
                    error_data = {"error": {"message": str(e), "type": "api_error"}}
                    yield f"data: {json.dumps(error_data)}\n\n"
                    yield "data: [DONE]\n\n"
                finally:
                    bridge_request_in_progress = False
            
            from flask import Response
            return Response(
                generate_stream(),
                mimetype='text/event-stream',
                headers={
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                }
            )
        
        else:
            # Non-streaming response with full tool call support
            logger.info(f"Making non-streaming request to: {API_BASE}/chat/completions")
            logger.info(f"SSL verify: {REQUESTS_SSL_VERIFY}")
            response = http_requests.post(
                f"{API_BASE}/chat/completions",
                headers=headers,
                json=payload,
                timeout=300,
                verify=REQUESTS_SSL_VERIFY
            )
            
            if response.status_code != 200:
                logger.error(f"LLM error: {response.status_code} - {response.text[:500]}")
                try:
                    return jsonify(response.json()), response.status_code
                except:
                    return jsonify({"error": {"message": response.text, "type": "api_error"}}), response.status_code
            
            result = response.json()
            
            # Check what type of response we got
            if result.get('choices') and len(result['choices']) > 0:
                message = result['choices'][0].get('message', {})
                tool_calls = message.get('tool_calls')
                content = message.get('content', '')
                finish_reason = result['choices'][0].get('finish_reason', '')
                
                if tool_calls:
                    # Response contains tool calls - pass through to Zed
                    tool_names = [tc.get('function', {}).get('name', 'unknown') for tc in tool_calls]
                    logger.info(f"=== ZED RESPONSE - TOOL CALLS ===")
                    logger.info(f"Tool calls ({len(tool_calls)}): {tool_names}")
                    logger.info(f"Finish reason: {finish_reason}")
                    # Don't store - Zed will execute tools and continue
                elif content:
                    # Final text response
                    logger.info(f"=== ZED RESPONSE - TEXT ===")
                    logger.info(f"Assistant (truncated): {content[:200]}...")
                    logger.info(f"Finish reason: {finish_reason}")
                    
                    # Store final text responses (filter out system messages)
                    if user_message and content.strip() and not is_system_message(user_message):
                        conversation_entry = {
                            "id": str(uuid.uuid4()),
                            "timestamp": time.time(),
                            "user_message": user_message,
                            "assistant_message": content,
                            "model": model,
                            "had_tool_execution": has_tool_results or has_tool_calls_in_history,
                            "source": "proxy"
                        }
                        zed_conversations.append(conversation_entry)
                        
                        if len(zed_conversations) > 50:
                            zed_conversations.pop(0)
                        
                        try:
                            with open('/tmp/zed-latest-conversation.json', 'w') as f:
                                json.dump(conversation_entry, f)
                        except Exception as e:
                            logger.error(f"Error writing conversation file: {e}")
                        
                        logger.info(f"Conversation stored. Total: {len(zed_conversations)}")
                    elif is_system_message(user_message):
                        logger.info(f"Filtered system message: {user_message[:50]}...")
                else:
                    logger.info(f"=== ZED RESPONSE - EMPTY ===")
                    logger.info(f"Finish reason: {finish_reason}")
            
            # Pass through the full response unchanged
            return jsonify(result)
    
    except http_requests.exceptions.SSLError as ssl_err:
        logger.error(f"SSL Error connecting to LLM: {ssl_err}")
        logger.error(f"API_BASE: {API_BASE}")
        logger.error(f"SSL_VERIFY setting: {REQUESTS_SSL_VERIFY}")
        logger.error("Try setting SSL_VERIFY=false in environment or check SSL certificates")
        return jsonify({
            "error": {
                "message": f"SSL certificate error: {str(ssl_err)}. Try setting SSL_VERIFY=false",
                "type": "ssl_error",
                "details": {
                    "api_base": API_BASE,
                    "ssl_verify": str(REQUESTS_SSL_VERIFY)
                }
            }
        }), 502
    except http_requests.exceptions.ConnectionError as conn_err:
        logger.error(f"Connection error to LLM: {conn_err}")
        logger.error(f"API_BASE: {API_BASE}")
        return jsonify({
            "error": {
                "message": f"Connection error: {str(conn_err)}",
                "type": "connection_error"
            }
        }), 502
    except Exception as e:
        logger.error(f"Proxy error: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return jsonify({
            "error": {
                "message": str(e),
                "type": "api_error"
            }
        }), 500
    finally:
        if not stream:
            bridge_request_in_progress = False

@app.route('/v1/models', methods=['GET'])
def openai_list_models():
    """OpenAI-compatible models list endpoint"""
    return jsonify({
        "object": "list",
        "data": [
            {
                "id": MODEL,
                "object": "model",
                "created": 1700000000,
                "owned_by": "devpilot"
            }
        ]
    })

@app.route('/ssl-test', methods=['GET'])
def ssl_test():
    """Test SSL connectivity to LLM API and other services"""
    import requests as http_requests
    results = {
        "ssl_verify_setting": str(REQUESTS_SSL_VERIFY),
        "ssl_cert_file": SSL_CERT_FILE,
        "ssl_cert_exists": os.path.exists(SSL_CERT_FILE) if SSL_CERT_FILE else False,
        "api_base": API_BASE,
        "tests": []
    }
    
    # Test 1: Connect to API_BASE
    try:
        logger.info(f"SSL Test: Connecting to {API_BASE}/models")
        headers = {"Authorization": f"Bearer {API_KEY}"} if API_KEY else {}
        resp = http_requests.get(f"{API_BASE}/models", headers=headers, timeout=10, verify=REQUESTS_SSL_VERIFY)
        results["tests"].append({
            "name": "LLM API",
            "url": f"{API_BASE}/models",
            "success": True,
            "status_code": resp.status_code
        })
    except http_requests.exceptions.SSLError as e:
        results["tests"].append({
            "name": "LLM API",
            "url": f"{API_BASE}/models",
            "success": False,
            "error": f"SSL Error: {str(e)}"
        })
    except Exception as e:
        results["tests"].append({
            "name": "LLM API",
            "url": f"{API_BASE}/models",
            "success": False,
            "error": str(e)
        })
    
    # Test 2: Connect to github.com (for git clone)
    try:
        logger.info("SSL Test: Connecting to github.com")
        resp = http_requests.get("https://github.com", timeout=10, verify=REQUESTS_SSL_VERIFY)
        results["tests"].append({
            "name": "GitHub",
            "url": "https://github.com",
            "success": True,
            "status_code": resp.status_code
        })
    except http_requests.exceptions.SSLError as e:
        results["tests"].append({
            "name": "GitHub",
            "url": "https://github.com",
            "success": False,
            "error": f"SSL Error: {str(e)}"
        })
    except Exception as e:
        results["tests"].append({
            "name": "GitHub",
            "url": "https://github.com",
            "success": False,
            "error": str(e)
        })
    
    # Test 3: Connect with verify=False explicitly
    try:
        logger.info("SSL Test: Connecting with verify=False")
        resp = http_requests.get("https://github.com", timeout=10, verify=False)
        results["tests"].append({
            "name": "GitHub (no verify)",
            "url": "https://github.com",
            "success": True,
            "status_code": resp.status_code,
            "note": "verify=False works"
        })
    except Exception as e:
        results["tests"].append({
            "name": "GitHub (no verify)",
            "url": "https://github.com",
            "success": False,
            "error": str(e)
        })
    
    # Log results
    logger.info(f"SSL Test Results: {json.dumps(results, indent=2)}")
    
    return jsonify(results)

@app.route('/zed/conversations', methods=['GET'])
def get_zed_conversations():
    """Get all Zed conversations (for frontend)"""
    return jsonify({
        "conversations": zed_conversations,
        "count": len(zed_conversations)
    })

@app.route('/zed/latest', methods=['GET'])
def get_latest_conversation():
    """Get the latest Zed conversation"""
    if zed_conversations:
        return jsonify(zed_conversations[-1])
    return jsonify({"error": "No conversations yet"}), 404

@app.route('/debug', methods=['GET'])
def debug_status():
    """Debug endpoint to check Bridge API status and all conversations"""
    import subprocess
    env = {**os.environ, 'DISPLAY': ':0'}
    
    # Check Zed process
    zed_running = False
    zed_pid = None
    try:
        result = subprocess.run(['pgrep', '-f', 'zed-editor'], capture_output=True, text=True)
        if result.stdout.strip():
            zed_running = True
            zed_pid = result.stdout.strip().split('\n')[0]
    except:
        pass
    
    # Check Zed window
    zed_window = find_zed_window()
    
    # Get window name if found
    window_name = None
    if zed_window:
        try:
            result = subprocess.run(['xdotool', 'getwindowname', zed_window], 
                                   capture_output=True, text=True, env=env)
            window_name = result.stdout.strip()
        except:
            pass
    
    # Get summary of ALL conversations
    conversations_summary = []
    for conv in zed_conversations:
        conversations_summary.append({
            "id": conv.get("id", "?")[:8],
            "timestamp": conv.get("timestamp", 0),
            "user_msg_preview": conv.get("user_message", "")[:80],
            "assistant_msg_preview": conv.get("assistant_message", "")[:80],
            "source": conv.get("source", "unknown")
        })
    
    return jsonify({
        "status": "ok",
        "api_configured": bool(API_KEY),
        "model": MODEL,
        "api_base": API_BASE,
        "project_path": PROJECT_PATH,
        "zed_running": zed_running,
        "zed_pid": zed_pid,
        "zed_window_id": zed_window,
        "zed_window_name": window_name,
        "conversations_count": len(zed_conversations),
        "all_conversations": conversations_summary
    })

# ============================================================
# ACP Agent Conversations (from external DevPilot agent)
# ============================================================
@app.route('/acp/conversations', methods=['GET'])
def get_acp_conversations():
    """Get conversations from the ACP DevPilot agent"""
    try:
        acp_file = "/tmp/devpilot-acp-conversations.json"
        if os.path.exists(acp_file):
            with open(acp_file, 'r') as f:
                return jsonify(json.load(f))
        return jsonify({"conversations": [], "count": 0})
    except Exception as e:
        logger.error(f"Error reading ACP conversations: {e}")
        return jsonify({"conversations": [], "count": 0, "error": str(e)})

@app.route('/acp/latest', methods=['GET'])
def get_acp_latest():
    """Get the latest ACP conversation"""
    try:
        acp_file = "/tmp/devpilot-acp-conversations.json"
        if os.path.exists(acp_file):
            with open(acp_file, 'r') as f:
                data = json.load(f)
                conversations = data.get("conversations", [])
                if conversations:
                    return jsonify(conversations[-1])
        return jsonify({"error": "No ACP conversations yet"}), 404
    except Exception as e:
        logger.error(f"Error reading ACP latest: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/all-conversations', methods=['GET'])
def get_all_conversations():
    """Get all conversations from both proxy and ACP agent"""
    all_convs = []
    
    # Add proxy conversations
    all_convs.extend([{**c, "source": "proxy"} for c in zed_conversations])
    
    # Add ACP conversations
    try:
        acp_file = "/tmp/devpilot-acp-conversations.json"
        if os.path.exists(acp_file):
            with open(acp_file, 'r') as f:
                data = json.load(f)
                all_convs.extend(data.get("conversations", []))
    except:
        pass
    
    # Sort by timestamp
    all_convs.sort(key=lambda x: x.get("timestamp", 0))
    
    return jsonify({
        "conversations": all_convs,
        "count": len(all_convs),
        "request_in_progress": bridge_request_in_progress
    })

@app.route('/chat', methods=['POST'])
def chat():
    """
    Send a chat message directly to the AI (bypasses Zed/xdotool)
    Body: { "message": "your prompt here" }
    
    This is an alternative to sendZedPrompt that directly calls the LLM.
    Use this if xdotool-based prompting isn't working.
    """
    if not client:
        return jsonify({"error": "API not configured"}), 500
    
    data = request.get_json()
    message = data.get('message', '')
    
    if not message:
        return jsonify({"error": "No message provided"}), 400
    
    logger.info(f"=== DIRECT CHAT REQUEST ===")
    logger.info(f"Message: {message[:100]}...")
    
    try:
        import time
        import uuid
        
        # Build context
        system_prompt = f"""You are DevPilot, an AI coding assistant.
You are helping analyze a project at: {PROJECT_PATH}
Be concise and helpful."""
        
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(conversation_history[-10:])  # Last 10 messages
        messages.append({"role": "user", "content": message})
        
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            max_tokens=4096
        )
        
        assistant_message = response.choices[0].message.content
        
        # Store in conversation history (for context)
        conversation_history.append({"role": "user", "content": message})
        conversation_history.append({"role": "assistant", "content": assistant_message})
        
        # Also store in zed_conversations so frontend can see it (filter system messages)
        if not is_system_message(message):
            conversation_entry = {
                "id": str(uuid.uuid4()),
                "timestamp": time.time(),
                "user_message": message,
                "assistant_message": assistant_message,
                "model": MODEL,
                "source": "direct_chat"
            }
            zed_conversations.append(conversation_entry)
            if len(zed_conversations) > 50:
                zed_conversations.pop(0)
            
            # Write to file for persistence
            try:
                with open('/tmp/zed-latest-conversation.json', 'w') as f:
                    json.dump(conversation_entry, f)
            except:
                pass
        
        logger.info(f"=== DIRECT CHAT RESPONSE ===")
        logger.info(f"Response: {assistant_message[:200]}...")
        
        return jsonify({
            "response": assistant_message,
            "model": MODEL,
            "conversation_id": conversation_entry["id"]
        })
    
    except Exception as e:
        logger.error(f"Chat error: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@app.route('/analyze', methods=['POST'])
def analyze():
    """
    Analyze the current project
    Body: { "focus": "optional focus area" }
    """
    if not client:
        return jsonify({"error": "API not configured"}), 500
    
    data = request.get_json() or {}
    focus = data.get('focus', 'general overview')
    
    # Gather project info
    project_info = []
    
    # Check for common files
    for filename in ['README.md', 'package.json', 'requirements.txt', 'pom.xml']:
        filepath = os.path.join(PROJECT_PATH, filename)
        if os.path.exists(filepath):
            try:
                with open(filepath, 'r') as f:
                    content = f.read()[:3000]
                project_info.append(f"### {filename}:\n```\n{content}\n```")
            except:
                pass
    
    # List directory
    try:
        items = os.listdir(PROJECT_PATH)
        project_info.append(f"### Files: {', '.join(items[:50])}")
    except:
        pass
    
    context = "\n\n".join(project_info)
    
    prompt = f"""Analyze this project with focus on: {focus}

{context}

Provide:
1. Project overview
2. Main technologies used
3. Key observations
4. Potential improvements"""
    
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=4096
        )
        
        return jsonify({
            "analysis": response.choices[0].message.content,
            "model": MODEL,
            "project_path": PROJECT_PATH
        })
    
    except Exception as e:
        logger.error(f"Analysis error: {e}")
        return jsonify({"error": str(e)}), 500

def find_zed_window():
    """Find Zed window by process ID, project name, or window title"""
    env = {**os.environ, 'DISPLAY': ':0'}
    skip_names = {'desktop', 'xfce4-panel', 'thunar', 'xfwm4', 'xterm', 'gnome-terminal'}

    def is_valid_zed_window(name):
        if not name or 'crash' in name.lower():
            return False
        n = name.lower()
        if n in skip_names or 'wrapper' in n or n.startswith('xf'):
            return False
        return True

    # Method 1: Find by zed-editor or zed PID (try both process names)
    for proc_pattern in ['zed-editor', 'zed']:
        try:
            pid_result = subprocess.run(['pgrep', '-f', proc_pattern], capture_output=True, text=True)
            if pid_result.stdout.strip():
                zed_pid = pid_result.stdout.strip().split('\n')[0]
                result = subprocess.run(
                    ['xdotool', 'search', '--pid', zed_pid],
                    capture_output=True, text=True, env=env
                )
                windows = [w for w in result.stdout.strip().split('\n') if w]
                for win in windows:
                    name_result = subprocess.run(
                        ['xdotool', 'getwindowname', win],
                        capture_output=True, text=True, env=env
                    )
                    name = name_result.stdout.strip()
                    if is_valid_zed_window(name):
                        logger.info(f"Found Zed window by PID ({proc_pattern}): {win} ({name})")
                        return win
        except Exception as e:
            logger.warning(f"PID search ({proc_pattern}) failed: {e}")

    # Method 2: Find by project name from environment
    project_name = os.environ.get('REPO_NAME', '')
    if project_name:
        try:
            result = subprocess.run(
                ['xdotool', 'search', '--name', project_name],
                capture_output=True, text=True, env=env
            )
            windows = [w for w in result.stdout.strip().split('\n') if w]
            if windows:
                logger.info(f"Found Zed window by project name: {windows[0]}")
                return windows[0]
        except Exception as e:
            logger.warning(f"Project name search failed: {e}")

    # Method 3: Find by "Zed" in window name (Zed shows "Zed" or "project - Zed" in title)
    try:
        result = subprocess.run(
            ['xdotool', 'search', '--name', 'Zed'],
            capture_output=True, text=True, env=env
        )
        windows = [w for w in result.stdout.strip().split('\n') if w]
        for win in windows:
            name_result = subprocess.run(
                ['xdotool', 'getwindowname', win],
                capture_output=True, text=True, env=env
            )
            name = name_result.stdout.strip()
            if is_valid_zed_window(name):
                logger.info(f"Found Zed window by name 'Zed': {win} ({name})")
                return win
    except Exception as e:
        logger.warning(f"Zed name search failed: {e}")

    # Method 4: Find by class (Zed may use "zed" or "Zed" as WM_CLASS)
    for class_pattern in ['zed', 'Zed']:
        try:
            result = subprocess.run(
                ['xdotool', 'search', '--class', class_pattern],
                capture_output=True, text=True, env=env
            )
            windows = [w for w in result.stdout.strip().split('\n') if w]
            if windows:
                logger.info(f"Found Zed window by class: {windows[0]}")
                return windows[0]
        except Exception as e:
            logger.warning(f"Class search ({class_pattern}) failed: {e}")

    # Method 5: Fallback - iterate all windows (try without --onlyvisible first)
    try:
        result = subprocess.run(
            ['xdotool', 'search', '--name', '.'],
            capture_output=True, text=True, env=env
        )
        for win in result.stdout.strip().split('\n'):
            if win:
                name_result = subprocess.run(
                    ['xdotool', 'getwindowname', win],
                    capture_output=True, text=True, env=env
                )
                name = name_result.stdout.strip()
                if is_valid_zed_window(name) and ('zed' in name.lower() or '/' in name):
                    logger.info(f"Found potential Zed window: {win} ({name})")
                    return win
    except Exception as e:
        logger.warning(f"Fallback window search failed: {e}")

    return None

def open_agent_panel(window_id, env, max_attempts=3):
    """Open Zed's agent panel via the command palette.

    Direct shortcuts (ctrl+shift+slash / ctrl+shift+question) are unreliable
    across Zed versions and X11 keyboard configurations.  The command palette
    (Ctrl+Shift+P -> "agent: toggle") works consistently.
    """
    import time

    for attempt in range(max_attempts):
        logger.info(f"Opening agent panel attempt {attempt + 1}/{max_attempts} via command palette")

        subprocess.run(['xdotool', 'windowactivate', '--sync', window_id], env=env)
        subprocess.run(['xdotool', 'windowfocus', '--sync', window_id], env=env)
        time.sleep(0.5)

        # Open command palette
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+shift+p'], env=env)
        time.sleep(1.5)

        # Type the command and execute it
        subprocess.run(['xdotool', 'type', '--delay', '30', 'agent: toggle'], env=env)
        time.sleep(0.5)
        subprocess.run(['xdotool', 'key', 'Return'], env=env)
        time.sleep(1.5)

        logger.info(f"Agent panel toggle sent (attempt {attempt + 1})")
        break

    return True

@app.route('/zed/open-agent', methods=['POST'])
def zed_open_agent():
    """Open Zed's agent panel using xdotool"""
    import time
    try:
        window_id = None
        for attempt in range(14):
            window_id = find_zed_window()
            if window_id:
                break
            if attempt < 13:
                time.sleep(4)
        
        if not window_id:
            return jsonify({"error": "Zed window not found"}), 404
        
        env = {**os.environ, 'DISPLAY': ':0'}
        
        open_agent_panel(window_id, env, max_attempts=2)
        
        return jsonify({"status": "ok", "window_id": window_id})
    
    except Exception as e:
        logger.error(f"Zed control error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/debug/test-input', methods=['POST'])
def debug_test_input():
    """Test endpoint to debug text input methods"""
    data = request.get_json() or {}
    test_text = data.get('text', 'Hello from DevPilot test!')
    
    env = {**os.environ, 'DISPLAY': ':0'}
    results = {
        'test_text': test_text,
        'clipboard_tools': {},
        'xdotool_available': False,
        'tests': []
    }
    
    # Check available tools
    for tool in ['xclip', 'xsel', 'xdotool']:
        check = subprocess.run(['which', tool], capture_output=True, text=True, env=env)
        if tool in ['xclip', 'xsel']:
            results['clipboard_tools'][tool] = check.returncode == 0
        else:
            results['xdotool_available'] = check.returncode == 0
    
    # Test xsel (preferred - doesn't hang like xclip)
    if results['clipboard_tools'].get('xsel'):
        try:
            proc = subprocess.run(
                ['xsel', '--clipboard', '--input'],
                input=test_text.encode('utf-8'),
                env=env,
                capture_output=True,
                timeout=5
            )
            results['tests'].append({
                'method': 'xsel_write',
                'success': proc.returncode == 0,
                'stderr': proc.stderr.decode() if proc.stderr else None
            })
            
            # Try to read back
            read_proc = subprocess.run(
                ['xsel', '--clipboard', '--output'],
                env=env,
                capture_output=True,
                timeout=5
            )
            results['tests'].append({
                'method': 'xsel_read',
                'success': read_proc.returncode == 0,
                'content_matches': read_proc.stdout.decode() == test_text if read_proc.returncode == 0 else False,
                'content': read_proc.stdout.decode()[:100] if read_proc.returncode == 0 else None
            })
        except Exception as e:
            results['tests'].append({
                'method': 'xsel',
                'success': False,
                'error': str(e)
            })
    
    # Test xdotool type (on a dummy window or just check it works)
    if results['xdotool_available']:
        try:
            # Just test that xdotool can run
            proc = subprocess.run(
                ['xdotool', 'version'],
                env=env,
                capture_output=True,
                timeout=5
            )
            results['tests'].append({
                'method': 'xdotool_version',
                'success': proc.returncode == 0,
                'version': proc.stdout.decode().strip() if proc.returncode == 0 else None
            })
        except Exception as e:
            results['tests'].append({
                'method': 'xdotool',
                'success': False,
                'error': str(e)
            })
    
    # Check if Zed window exists
    zed_window = find_zed_window()
    results['zed_window'] = zed_window
    
    return jsonify(results)

@app.route('/zed/send-prompt', methods=['POST'])
def zed_send_prompt():
    """Send a prompt to Zed's agent panel using keyboard simulation"""
    import time
    data = request.get_json()
    prompt = data.get('prompt', '')
    
    if not prompt:
        return jsonify({"error": "No prompt provided"}), 400
    
    logger.info(f"=== SEND PROMPT REQUEST ===")
    logger.info(f"Prompt: {prompt[:100]}...")
    
    try:
        # Retry finding Zed window (Zed can take 20-40s to show window with software rendering)
        window_id = None
        max_retries = 14
        retry_interval = 4
        # Brief initial delay: Zed may need a few seconds before its window is mapped
        time.sleep(2)
        for attempt in range(max_retries):
            window_id = find_zed_window()
            if window_id:
                break
            if attempt < max_retries - 1:
                logger.info(f"Zed window not found yet, retry {attempt + 1}/{max_retries} in {retry_interval}s...")
                time.sleep(retry_interval)
        
        if not window_id:
            logger.error("Zed window not found after retries!")
            return jsonify({"error": "Zed window not found"}), 404
        
        logger.info(f"Found Zed window: {window_id}")
        env = {**os.environ, 'DISPLAY': ':0'}
        
        import time
        
        # Step 1: Focus Zed window
        logger.info("Step 1: Focusing Zed window...")
        subprocess.run(['xdotool', 'windowactivate', '--sync', window_id], env=env)
        time.sleep(0.5)
        
        # Step 2: Press Escape to close any dialogs/panels and ensure clean state
        logger.info("Step 2: Pressing Escape to clear state...")
        subprocess.run(['xdotool', 'key', 'Escape'], env=env)
        time.sleep(0.3)
        
        # Step 3: Open the agent panel with retry + multiple keystroke strategies
        logger.info("Step 3: Opening agent panel...")
        open_agent_panel(window_id, env, max_attempts=2)
        
        # Step 4: Focus should now be in the agent input. 
        # Press End to go to end of any existing text, then select all and delete
        logger.info("Step 4: Preparing input area...")
        subprocess.run(['xdotool', 'key', 'End'], env=env)
        time.sleep(0.1)
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+a'], env=env)
        time.sleep(0.1)
        subprocess.run(['xdotool', 'key', 'BackSpace'], env=env)
        time.sleep(0.3)
        
        # Step 5: Input the prompt using xsel (xclip has timeout issues)
        logger.info(f"Step 5: Inputting prompt ({len(prompt)} chars)...")
        
        clipboard_success = False
        
        # Try xsel first (doesn't have the timeout issues that xclip has)
        try:
            check_xsel = subprocess.run(['which', 'xsel'], capture_output=True, env=env)
            if check_xsel.returncode == 0:
                logger.info("Using xsel for clipboard...")
                
                # xsel --clipboard --input doesn't hang like xclip does
                xsel_proc = subprocess.run(
                    ['xsel', '--clipboard', '--input'],
                    input=prompt.encode('utf-8'),
                    env=env,
                    capture_output=True,
                    timeout=5
                )
                
                if xsel_proc.returncode == 0:
                    logger.info("xsel clipboard copy successful")
                    time.sleep(0.2)
                    
                    # Paste with Ctrl+Shift+V (works better in terminals) or Ctrl+V
                    logger.info("Pasting from clipboard...")
                    subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+v'], env=env)
                    time.sleep(0.5)
                    clipboard_success = True
                else:
                    logger.warning(f"xsel failed: {xsel_proc.stderr.decode() if xsel_proc.stderr else 'unknown'}")
        except subprocess.TimeoutExpired:
            logger.warning("xsel timed out")
        except Exception as e:
            logger.warning(f"xsel error: {e}")
        
        # Fallback: use xdotool type
        if not clipboard_success:
            logger.info("Clipboard failed, using xdotool type fallback...")
            
            # Clean prompt for xdotool (remove problematic chars)
            safe_prompt = prompt
            safe_prompt = safe_prompt.replace('`', "'")
            safe_prompt = safe_prompt.replace('\t', '    ')  # tabs to spaces
            
            # Type in chunks to avoid buffer issues
            chunk_size = 100
            total_chunks = (len(safe_prompt) + chunk_size - 1) // chunk_size
            
            for i in range(0, len(safe_prompt), chunk_size):
                chunk = safe_prompt[i:i+chunk_size]
                chunk_num = (i // chunk_size) + 1
                logger.info(f"Typing chunk {chunk_num}/{total_chunks} ({len(chunk)} chars)")
                
                result = subprocess.run(
                    ['xdotool', 'type', '--delay', '10', '--clearmodifiers', '--', chunk],
                    env=env, capture_output=True, text=True, timeout=60
                )
                if result.returncode != 0:
                    logger.warning(f"Type error: {result.stderr}")
                # Brief pause between chunks
                time.sleep(0.05)
            
            time.sleep(0.3)
        
        # Step 6: Submit with Enter
        logger.info("Step 6: Submitting with Enter...")
        subprocess.run(['xdotool', 'key', 'Return'], env=env)
        time.sleep(0.5)
        
        # Step 7: Open terminal panel (once) now that the prompt is safely submitted
        global _terminal_panel_opened
        if not _terminal_panel_opened:
            logger.info("Step 7: Opening terminal panel (ctrl+backtick)...")
            subprocess.run(['xdotool', 'windowactivate', '--sync', window_id], env=env)
            time.sleep(0.3)
            subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+grave'], env=env)
            time.sleep(0.3)
            _terminal_panel_opened = True
        
        # Track pending prompt
        try:
            import uuid as uuid_module
            pending_entry = {
                "id": str(uuid_module.uuid4()),
                "timestamp": time.time(),
                "prompt": prompt,
                "window_id": window_id,
                "status": "sent"
            }
            with open('/tmp/devpilot-pending-prompts.json', 'a') as f:
                f.write(json.dumps(pending_entry) + '\n')
        except:
            pass
        
        logger.info("=== PROMPT SENT SUCCESSFULLY ===")
        return jsonify({"status": "ok", "prompt_sent": prompt, "window_id": window_id})
    
    except Exception as e:
        logger.error(f"Zed send prompt error: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@app.route('/clipboard/paste', methods=['POST'])
def clipboard_paste():
    """Set the X11 CLIPBOARD via xclip and trigger Ctrl+V via xdotool.
    
    x11vnc's clipboard channel is broken on Ubuntu 24.04 (libvncserver 0.9.14 bug)
    and doesn't provide UTF8_STRING targets that Zed requires.
    xclip properly forks a daemon that maintains ownership and serves UTF8_STRING.
    xdotool sends a real X11 keystroke so the focused app pastes reliably.
    """
    import time as _time
    data = request.get_json()
    text = data.get('text', '')
    if not text:
        return jsonify({"status": "empty"}), 200
    
    env = {**os.environ, 'DISPLAY': ':0'}
    try:
        proc = subprocess.Popen(
            ['xclip', '-selection', 'clipboard'],
            stdin=subprocess.PIPE,
            env=env
        )
        proc.communicate(input=text.encode('utf-8'), timeout=5)
        
        _time.sleep(0.1)
        
        subprocess.run(
            ['xdotool', 'key', '--clearmodifiers', 'ctrl+v'],
            env=env,
            timeout=5
        )
        
        return jsonify({"status": "ok"})
    except Exception as e:
        logger.error(f"clipboard/paste error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/history', methods=['GET'])
def get_history():
    """Get conversation history"""
    return jsonify({"history": conversation_history})

@app.route('/history', methods=['DELETE'])
def clear_history():
    """Clear conversation history"""
    global conversation_history
    conversation_history = []
    return jsonify({"status": "cleared"})

@app.route('/project/files', methods=['GET'])
def list_files():
    """List project files"""
    try:
        items = []
        for item in os.listdir(PROJECT_PATH):
            path = os.path.join(PROJECT_PATH, item)
            items.append({
                "name": item,
                "type": "directory" if os.path.isdir(path) else "file"
            })
        return jsonify({"files": items, "path": PROJECT_PATH})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/project/read', methods=['POST'])
def read_file():
    """Read a file from the project"""
    data = request.get_json()
    filepath = data.get('path', '')
    
    # Security: ensure path is within project
    full_path = os.path.normpath(os.path.join(PROJECT_PATH, filepath))
    if not full_path.startswith(PROJECT_PATH):
        return jsonify({"error": "Invalid path"}), 400
    
    try:
        with open(full_path, 'r') as f:
            content = f.read()
        return jsonify({"content": content, "path": filepath})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def get_git_project_path():
    """Get the git repository path (may be PROJECT_PATH or PROJECT_PATH/REPO_NAME)"""
    repo_name = os.environ.get('REPO_NAME', '')
    if repo_name:
        return os.path.join(PROJECT_PATH, repo_name)
    return PROJECT_PATH

@app.route('/git/push-and-create-pr', methods=['POST'])
def git_push_and_create_pr():
    """
    Push changes and prepare for PR creation.
    Runs: git add, commit, push to new branch.
    PR creation is done by the backend after push succeeds.
    """
    data = request.get_json() or {}
    branch_name = data.get('branch_name', '')
    commit_message = data.get('commit_message', 'Implement user story')
    pr_title = data.get('pr_title', '')
    pr_body = data.get('pr_body', '')
    git_credentials = data.get('git_credentials', '')  # PAT or OAuth token for push auth
    
    if not branch_name:
        return jsonify({"error": "branch_name is required"}), 400
    
    git_path = get_git_project_path()
    if not os.path.isdir(os.path.join(git_path, '.git')):
        return jsonify({"error": "Not a git repository", "path": git_path}), 400
    
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    
    try:
        results = []
        
        # If credentials provided, update the remote URL to include them
        if git_credentials:
            # Get current remote URL
            remote_result = subprocess.run(['git', 'remote', 'get-url', 'origin'],
                                         cwd=git_path, capture_output=True, text=True, env=env)
            if remote_result.returncode == 0:
                current_url = remote_result.stdout.strip()
                # Check if URL already has credentials (https://TOKEN@...)
                if '@' in current_url and current_url.startswith('https://'):
                    # Replace existing credentials
                    import re
                    new_url = re.sub(r'https://[^@]+@', f'https://{git_credentials}@', current_url)
                elif current_url.startswith('https://'):
                    # Add credentials to URL
                    new_url = current_url.replace('https://', f'https://{git_credentials}@')
                else:
                    new_url = current_url
                
                if new_url != current_url:
                    subprocess.run(['git', 'remote', 'set-url', 'origin', new_url],
                                 cwd=git_path, capture_output=True, text=True, env=env)
                    logger.info("Updated remote URL with credentials for push")
        
        # Configure git user
        subprocess.run(['git', 'config', 'user.email', 'devpilot@devpilot.local'],
                      cwd=git_path, capture_output=True, text=True, env=env, check=True)
        subprocess.run(['git', 'config', 'user.name', 'DevPilot'],
                      cwd=git_path, capture_output=True, text=True, env=env, check=True)
        
        # Create and checkout new branch
        checkout = subprocess.run(['git', 'checkout', '-b', branch_name],
                                 cwd=git_path, capture_output=True, text=True, env=env)
        if checkout.returncode != 0 and 'already exists' not in checkout.stderr:
            return jsonify({
                "error": "Failed to create branch",
                "stderr": checkout.stderr,
                "branch": branch_name
            }), 400
        elif checkout.returncode != 0:
            subprocess.run(['git', 'checkout', branch_name],
                         cwd=git_path, capture_output=True, text=True, env=env, check=True)
        
        # Add all changes
        add_result = subprocess.run(['git', 'add', '.'],
                                  cwd=git_path, capture_output=True, text=True, env=env)
        results.append({"step": "add", "returncode": add_result.returncode})
        
        # Check if there are changes to commit
        status_result = subprocess.run(['git', 'status', '--porcelain'],
                                     cwd=git_path, capture_output=True, text=True, env=env)
        if not status_result.stdout.strip():
            return jsonify({
                "error": "No changes to commit",
                "branch": branch_name
            }), 400
        
        # Commit
        commit_result = subprocess.run(['git', 'commit', '-m', commit_message],
                                     cwd=git_path, capture_output=True, text=True, env=env)
        if commit_result.returncode != 0:
            return jsonify({
                "error": "Failed to commit",
                "stderr": commit_result.stderr,
                "stdout": commit_result.stdout
            }), 400
        
        # Push (with force-with-lease to handle existing branches safely)
        push_result = subprocess.run(['git', 'push', '-u', '--force-with-lease', 'origin', branch_name],
                                    cwd=git_path, capture_output=True, text=True, env=env)
        if push_result.returncode != 0:
            # Retry after unshallow if push failed (e.g. "shallow update not allowed")
            stderr = (push_result.stderr or '') + (push_result.stdout or '')
            if 'shallow' in stderr.lower() or 'unshallow' in stderr.lower():
                try:
                    subprocess.run(['git', 'fetch', '--unshallow'],
                                  cwd=git_path, capture_output=True, text=True, env=env, timeout=120)
                    push_result = subprocess.run(['git', 'push', '-u', '--force-with-lease', 'origin', branch_name],
                                                cwd=git_path, capture_output=True, text=True, env=env)
                except (subprocess.TimeoutExpired, FileNotFoundError):
                    pass
            if push_result.returncode != 0:
                return jsonify({
                    "error": "Failed to push",
                    "stderr": push_result.stderr,
                    "stdout": push_result.stdout,
                    "branch": branch_name
                }), 400
        
        return jsonify({
            "status": "ok",
            "branch": branch_name,
            "message": "Changes pushed successfully",
            "pr_title": pr_title,
            "pr_body": pr_body
        })
    except subprocess.CalledProcessError as e:
        return jsonify({"error": str(e), "stderr": getattr(e, 'stderr', '')}), 500
    except Exception as e:
        logger.exception("Push failed")
        return jsonify({"error": str(e)}), 500

def _deferred_terminal_open():
    """Open the terminal panel after a delay if no prompt was sent."""
    import time
    time.sleep(60)
    global _terminal_panel_opened
    if _terminal_panel_opened:
        return
    logger.info("No prompt sent after 60s — opening terminal panel now")
    env = {**os.environ, 'DISPLAY': ':0'}
    window_id = find_zed_window()
    if window_id:
        subprocess.run(['xdotool', 'windowactivate', '--sync', window_id], env=env)
        time.sleep(0.3)
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+grave'], env=env)
        _terminal_panel_opened = True
        logger.info("Terminal panel opened (deferred)")

if __name__ == '__main__':
    import threading
    threading.Thread(target=_deferred_terminal_open, daemon=True).start()
    port = int(os.environ.get('BRIDGE_PORT', 8091))
    logger.info(f"Starting DevPilot Bridge API on port {port}")
    app.run(host='0.0.0.0', port=port, debug=False)
DEVPILOT_BRIDGE

# Desktop start script
cat > desktop/start.sh << 'DESKTOP_START'
#!/bin/bash
set -x  # Enable debug output

export DISPLAY=:0
export XDG_RUNTIME_DIR=/tmp/runtime-sandbox
export HOME=/home/sandbox

# SSL certificate environment variables (fixes SSL issues in sandbox)
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_DIR=/etc/ssl/certs
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
# Disable SSL verification (sandbox is a dev environment)
export SSL_VERIFY=false
export GIT_SSL_NO_VERIFY=true
export PYTHONHTTPSVERIFY=0
# .NET / NuGet SSL bypass
export DOTNET_SYSTEM_NET_HTTP_USESOCKETSHTTPHANDLER=0
export NUGET_CERT_REVOCATION_MODE=off
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NUGET_SIGNATURE_VERIFICATION=false
# npm: disable SSL validation
export NODE_TLS_REJECT_UNAUTHORIZED=0

# Configure git to disable SSL verification
git config --global http.sslVerify false 2>/dev/null || true
echo "[SSL] Git SSL verification disabled" >> /tmp/sandbox-debug.log

# npm: disable strict-ssl globally
npm config set strict-ssl false 2>/dev/null || true
echo "[SSL] npm strict-ssl disabled" >> /tmp/sandbox-debug.log

# Ensure curl/wget skip SSL in sandbox (for dotnet restore, npm install, etc.)
echo 'insecure' > /home/sandbox/.curlrc 2>/dev/null || true
echo 'check_certificate = off' > /home/sandbox/.wgetrc 2>/dev/null || true

# ── SSL certificate extraction for .NET ──
# CRITICAL: Split each cert into its OWN file. When multiple certs are in one file,
# c_rehash only indexes the FIRST cert. The root CA (last in chain) gets missed,
# causing .NET's X509Chain to fail with "partial chain" even though curl works fine.
echo "[SSL] Extracting live certificate chains at startup..." >> /tmp/sandbox-debug.log
CERT_HOSTS="api.nuget.org globalcdn.nuget.org nuget.org registry.npmjs.org"
for HOST in $CERT_HOSTS; do
    CHAIN=$(echo | openssl s_client -showcerts -connect ${HOST}:443 -servername ${HOST} 2>/dev/null)
    if [ -n "$CHAIN" ]; then
        # Split chain into individual cert files (one per cert)
        echo "$CHAIN" | awk -v host=${HOST} \
            'BEGIN{n=0} /BEGIN CERTIFICATE/{n++; fname="/tmp/cert-"host"-"n".pem"} \
             /BEGIN CERTIFICATE/,/END CERTIFICATE/{print > fname}' 2>/dev/null
        # Install each individual cert
        for CERTFILE in /tmp/cert-${HOST}-*.pem; do
            if [ -f "$CERTFILE" ]; then
                BASENAME=$(basename "$CERTFILE" .pem)
                sudo cp "$CERTFILE" /usr/local/share/ca-certificates/${BASENAME}.crt 2>/dev/null
                sudo cat "$CERTFILE" >> /etc/ssl/certs/ca-certificates.crt 2>/dev/null
                rm -f "$CERTFILE"
            fi
        done
        echo "[SSL] Extracted individual certs for ${HOST}" >> /tmp/sandbox-debug.log
    else
        echo "[SSL] WARNING: Could not connect to ${HOST}" >> /tmp/sandbox-debug.log
    fi
done
sudo update-ca-certificates 2>> /tmp/sandbox-debug.log || true
sudo c_rehash /etc/ssl/certs 2>/dev/null || true
echo "[SSL] Certificate store updated and rehashed" >> /tmp/sandbox-debug.log

# .NET / NuGet SSL settings (do NOT modify NuGet.Config - enterprise standard)
export DOTNET_NUGET_SIGNATURE_VERIFICATION=false

# Log version and environment variables for debugging
echo "=== DevPilot Sandbox v2.3.0 ===" > /tmp/sandbox-debug.log
echo "Started at: \$(date)" >> /tmp/sandbox-debug.log
echo "=== Environment Variables ===" >> /tmp/sandbox-debug.log
env >> /tmp/sandbox-debug.log
echo "===========================" >> /tmp/sandbox-debug.log

mkdir -p $XDG_RUNTIME_DIR && chmod 700 $XDG_RUNTIME_DIR

# Start X server with access control disabled (-ac) so any user can connect
Xvfb $DISPLAY -screen 0 ${RESOLUTION:-1920x1080x24} -ac +extension GLX +render -noreset &
sleep 2

# Allow sandbox user to access X display
xhost +local: 2>/dev/null || true

# Start D-Bus session bus and save address to file
dbus-launch --sh-syntax > /tmp/dbus-env.sh
source /tmp/dbus-env.sh
export DBUS_SESSION_BUS_ADDRESS
echo "D-Bus address: $DBUS_SESSION_BUS_ADDRESS"

# Initialize gnome-keyring with empty password (avoids password prompt)
echo "" | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null || true

# Configure XFCE panel and desktop BEFORE starting the session (so they are used on first load)
mkdir -p /home/sandbox/.config/xfce4
mkdir -p /home/sandbox/.config/xfce4/xfconf/xfce-perchannel-xml

# Create taskbar launchers (Terminal=17, Firefox=19, Zed=21) - must exist before panel reads config
mkdir -p /home/sandbox/.config/xfce4/panel/launcher-17
mkdir -p /home/sandbox/.config/xfce4/panel/launcher-19
mkdir -p /home/sandbox/.config/xfce4/panel/launcher-21

# Terminal launcher - copy from system or create minimal one
if [ -f /usr/share/applications/xfce4-terminal-emulator.desktop ]; then
  cp /usr/share/applications/xfce4-terminal-emulator.desktop /home/sandbox/.config/xfce4/panel/launcher-17/xfce4-terminal-emulator.desktop
else
  cat > /home/sandbox/.config/xfce4/panel/launcher-17/xfce4-terminal-emulator.desktop << 'TERMINALLAUNCHER'
[Desktop Entry]
Version=1.0
Type=Application
Exec=xfce4-terminal
Terminal=false
Categories=System;TerminalEmulator;
Name=Terminal
Comment=Terminal emulator
TERMINALLAUNCHER
fi

# Firefox launcher
cat > /home/sandbox/.config/xfce4/panel/launcher-19/firefox.desktop << 'FIREFOXLAUNCHER'
[Desktop Entry]
Version=1.0
Type=Application
Exec=/opt/firefox/firefox --no-sandbox %u
Icon=/opt/firefox/browser/chrome/icons/default/default128.png
StartupNotify=true
Terminal=false
Categories=Network;WebBrowser;
Name=Firefox
Comment=Browse the web with Firefox
FIREFOXLAUNCHER

# Zed launcher
cat > /home/sandbox/.config/xfce4/panel/launcher-21/zed.desktop << 'ZEDLAUNCHER'
[Desktop Entry]
Version=1.0
Type=Application
Exec=/home/sandbox/.local/bin/zed
Icon=/home/sandbox/.local/zed.app/share/icons/hicolor/512x512/apps/zed.png
StartupNotify=true
Terminal=false
Categories=Development;IDE;
Name=Zed
Comment=Code editor
ZEDLAUNCHER

# Panel config: only Terminal, Firefox, Zed on taskbar (panel-2)
cat > /home/sandbox/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml << 'PANELCONFIG'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <value type="int" value="2"/>
    <property name="dark-mode" type="bool" value="true"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=6;x=0;y=0"/>
      <property name="length" type="uint" value="100"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="icon-size" type="uint" value="16"/>
      <property name="size" type="uint" value="26"/>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/>
        <value type="int" value="2"/>
        <value type="int" value="3"/>
        <value type="int" value="4"/>
        <value type="int" value="5"/>
        <value type="int" value="6"/>
        <value type="int" value="8"/>
        <value type="int" value="11"/>
        <value type="int" value="12"/>
        <value type="int" value="13"/>
        <value type="int" value="14"/>
      </property>
    </property>
    <property name="panel-2" type="empty">
      <property name="autohide-behavior" type="uint" value="1"/>
      <property name="position" type="string" value="p=10;x=0;y=0"/>
      <property name="length" type="uint" value="1"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="size" type="uint" value="48"/>
      <property name="plugin-ids" type="array">
        <value type="int" value="15"/>
        <value type="int" value="16"/>
        <value type="int" value="17"/>
        <value type="int" value="19"/>
        <value type="int" value="21"/>
        <value type="int" value="22"/>
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="applicationsmenu"/>
    <property name="plugin-2" type="string" value="tasklist">
      <property name="grouping" type="uint" value="1"/>
    </property>
    <property name="plugin-3" type="string" value="separator">
      <property name="expand" type="bool" value="true"/>
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-4" type="string" value="pager"/>
    <property name="plugin-5" type="string" value="separator">
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-6" type="string" value="systray">
      <property name="square-icons" type="bool" value="true"/>
    </property>
    <property name="plugin-8" type="string" value="pulseaudio">
      <property name="enable-keyboard-shortcuts" type="bool" value="true"/>
      <property name="show-notifications" type="bool" value="true"/>
    </property>
    <property name="plugin-11" type="string" value="separator">
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-12" type="string" value="clock"/>
    <property name="plugin-13" type="string" value="separator">
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-14" type="string" value="actions"/>
    <property name="plugin-15" type="string" value="showdesktop"/>
    <property name="plugin-16" type="string" value="separator"/>
    <property name="plugin-17" type="string" value="launcher">
      <property name="items" type="array">
        <value type="string" value="xfce4-terminal-emulator.desktop"/>
      </property>
    </property>
    <property name="plugin-19" type="string" value="launcher">
      <property name="items" type="array">
        <value type="string" value="firefox.desktop"/>
      </property>
    </property>
    <property name="plugin-21" type="string" value="launcher">
      <property name="items" type="array">
        <value type="string" value="zed.desktop"/>
      </property>
    </property>
    <property name="plugin-22" type="string" value="separator"/>
  </property>
</channel>
PANELCONFIG

# Dark desktop background
cat > /home/sandbox/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml << 'DESKTOPCONFIG'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-desktop" version="1.0">
  <property name="backdrop" type="empty">
    <property name="screen0" type="empty">
      <property name="monitorscreen" type="empty">
        <property name="workspace0" type="empty">
          <property name="color-style" type="int" value="0"/>
          <property name="image-style" type="int" value="0"/>
          <property name="rgba1" type="array">
            <value type="double" value="0.101961"/>
            <value type="double" value="0.101961"/>
            <value type="double" value="0.117647"/>
            <value type="double" value="1"/>
          </property>
        </property>
      </property>
      <property name="monitoreDP-1" type="empty">
        <property name="workspace0" type="empty">
          <property name="color-style" type="int" value="0"/>
          <property name="image-style" type="int" value="0"/>
          <property name="rgba1" type="array">
            <value type="double" value="0.101961"/>
            <value type="double" value="0.101961"/>
            <value type="double" value="0.117647"/>
            <value type="double" value="1"/>
          </property>
        </property>
      </property>
    </property>
  </property>
  <property name="desktop-icons" type="empty">
    <property name="style" type="int" value="0"/>
  </property>
</channel>
DESKTOPCONFIG

# Firefox as default browser
echo "WebBrowser=firefox" > /home/sandbox/.config/xfce4/helpers.rc
mkdir -p /home/sandbox/.local/share/applications
xdg-mime default firefox.desktop x-scheme-handler/http 2>/dev/null || true
xdg-mime default firefox.desktop x-scheme-handler/https 2>/dev/null || true
xdg-settings set default-web-browser firefox.desktop 2>/dev/null || true

echo "Panel and desktop configured (Terminal, Firefox, Zed)" >> /tmp/sandbox-debug.log

# Start desktop with D-Bus (after config is in place)
startxfce4 &
sleep 5

# Restart panel so it reloads our config (Terminal, Firefox, Zed only)
# XFCE may have written default config on first start; this ensures our config is used
pkill -9 xfce4-panel 2>/dev/null || true
sleep 1
DISPLAY=:0 xfce4-panel &
sleep 1
echo "Panel restarted with Terminal, Firefox, Zed" >> /tmp/sandbox-debug.log

# Clipboard sync between PRIMARY and CLIPBOARD selections (enables copy-paste via VNC)
autocutsel -fork -selection CLIPBOARD &
autocutsel -fork -selection PRIMARY &
sleep 1

# Start VNC server
x11vnc -display $DISPLAY -forever -shared -rfbport 5900 -passwd "${VNC_PASSWORD:-devpilot}" -xkb -noxdamage &
sleep 1

# Start websockify on internal port 6081
websockify --web=/usr/share/novnc 6081 localhost:5900 &
sleep 1

# Start nginx on port 6080 (proxies websockify, adds CORS/X-Frame-Options headers)
sudo nginx &

# Set DevPilot environment variables
export DEVPILOT_MODEL="${DEVPILOT_MODEL:-gpt-4o}"
export DEVPILOT_PROVIDER="${DEVPILOT_PROVIDER:-openai}"
export DEVPILOT_PROJECT_PATH="/home/sandbox/projects"

# Start DevPilot Bridge API (for frontend communication)
echo "Starting DevPilot Bridge API on port 8091..."
/opt/devpilot-venv/bin/python /opt/devpilot/devpilot-bridge.py &
BRIDGE_PID=$!
echo "DevPilot Bridge API started (PID: $BRIDGE_PID)" >> /tmp/sandbox-debug.log

# Configure Zed AI settings if provided
echo "ZED_SETTINGS_JSON length: ${#ZED_SETTINGS_JSON}" >> /tmp/sandbox-debug.log
mkdir -p /home/sandbox/.config/zed

# Use provided ZED_SETTINGS_JSON directly if available (it has the correct model)
if [ -n "$ZED_SETTINGS_JSON" ]; then
    echo "Using provided Zed settings from API..."
    echo "$ZED_SETTINGS_JSON" > /home/sandbox/.config/zed/settings.json
else
    echo "No ZED_SETTINGS_JSON provided, using defaults with proxy..."
    # Default settings MUST route through Bridge API proxy to capture conversations
    # The proxy at localhost:8091 forwards to the actual LLM provider
    cat > /home/sandbox/.config/zed/settings.json << 'ZEDSETTINGS'
{
  "theme": "One Dark",
  "ui_font_size": 14,
  "buffer_font_size": 14,
  "agent": {
    "enabled": true,
    "default_model": {
      "provider": "openai",
      "model": "gpt-4o"
    },
    "always_allow_tool_actions": true
  },
  "language_models": {
    "openai": {
      "api_url": "http://localhost:8091/v1",
      "available_models": [
        {"name": "gpt-4o", "display_name": "GPT-4o", "max_tokens": 128000}
      ]
    }
  },
  "features": {
    "edit_prediction_provider": "zed"
  },
  "terminal": {
    "dock": "bottom",
    "env": {
      "LIBGL_ALWAYS_SOFTWARE": "1"
    }
  },
  "worktree": {
    "trust_by_default": true
  },
  "telemetry": {
    "diagnostics": false,
    "metrics": false
  },
  "workspace": {
    "title_bar": {
      "show_onboarding_banner": false
    }
  },
  "show_call_status_icon": false
}
ZEDSETTINGS
fi

chmod 644 /home/sandbox/.config/zed/settings.json
# Files are already owned by sandbox since start.sh runs as sandbox user
echo "Zed settings written:" >> /tmp/sandbox-debug.log
cat /home/sandbox/.config/zed/settings.json >> /tmp/sandbox-debug.log

# ── Azure Service Principal login (for Key Vault, Azure SDK, etc.) ─────────────
if [ -n "$AZURE_CLIENT_ID" ] && [ -n "$AZURE_CLIENT_SECRET" ] && [ -n "$AZURE_TENANT_ID" ]; then
    echo "Logging in to Azure as Service Principal..." >> /tmp/sandbox-debug.log
    if command -v az >/dev/null 2>&1; then
        az login --service-principal \
            -u "$AZURE_CLIENT_ID" \
            -p "$AZURE_CLIENT_SECRET" \
            --tenant "$AZURE_TENANT_ID" \
            --output none 2>>/tmp/sandbox-debug.log || echo "az login failed (non-fatal)" >> /tmp/sandbox-debug.log
        echo "Azure SP login complete" >> /tmp/sandbox-debug.log
    else
        echo "az CLI not found, skipping az login (SDK will use env vars directly)" >> /tmp/sandbox-debug.log
    fi
fi

# ── Configure private artifact feeds ──────────────────────────────────────────
if [ -n "$ARTIFACT_FEEDS_JSON" ] && [ -n "$AZURE_DEVOPS_PAT" ]; then
    echo "Configuring artifact feeds..." >> /tmp/sandbox-debug.log

    NUGET_SOURCES=""
    NUGET_CREDS=""
    NPM_LINES=""
    PIP_EXTRA_URLS=""

    PAT_B64=$(echo -n "$AZURE_DEVOPS_PAT" | base64 -w0 2>/dev/null || echo -n "$AZURE_DEVOPS_PAT" | base64)

    FEED_COUNT=$(echo "$ARTIFACT_FEEDS_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)

    for i in $(seq 0 $((FEED_COUNT - 1))); do
        FEED_NAME=$(echo "$ARTIFACT_FEEDS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin)[$i]; print(d.get('name',''))")
        FEED_ORG=$(echo "$ARTIFACT_FEEDS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin)[$i]; print(d.get('organization',''))")
        FEED_FEED=$(echo "$ARTIFACT_FEEDS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin)[$i]; print(d.get('feed_name',d.get('feedName','')))")
        FEED_PROJ=$(echo "$ARTIFACT_FEEDS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin)[$i]; print(d.get('project_name',d.get('projectName','')) or '')")
        FEED_TYPE=$(echo "$ARTIFACT_FEEDS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin)[$i]; print(d.get('feed_type',d.get('feedType','nuget')))")

        if [ -n "$FEED_PROJ" ]; then
            URL_ORG_PART="${FEED_ORG}/${FEED_PROJ}"
        else
            URL_ORG_PART="${FEED_ORG}"
        fi

        case "$FEED_TYPE" in
            nuget)
                NUGET_SOURCES="${NUGET_SOURCES}    <add key=\"${FEED_NAME}\" value=\"https://pkgs.dev.azure.com/${URL_ORG_PART}/_packaging/${FEED_FEED}/nuget/v3/index.json\" />\n"
                NUGET_CREDS="${NUGET_CREDS}    <${FEED_NAME}>\n      <add key=\"Username\" value=\"az\" />\n      <add key=\"ClearTextPassword\" value=\"${AZURE_DEVOPS_PAT}\" />\n    </${FEED_NAME}>\n"
                ;;
            npm)
                NPM_LINES="${NPM_LINES}registry=https://pkgs.dev.azure.com/${URL_ORG_PART}/_packaging/${FEED_FEED}/npm/registry/\n"
                NPM_LINES="${NPM_LINES}always-auth=true\n"
                NPM_LINES="${NPM_LINES}//pkgs.dev.azure.com/${URL_ORG_PART}/_packaging/${FEED_FEED}/npm/registry/:username=az\n"
                NPM_LINES="${NPM_LINES}//pkgs.dev.azure.com/${URL_ORG_PART}/_packaging/${FEED_FEED}/npm/registry/:_password=${PAT_B64}\n"
                NPM_LINES="${NPM_LINES}//pkgs.dev.azure.com/${URL_ORG_PART}/_packaging/${FEED_FEED}/npm/registry/:email=not-used\n"
                ;;
            pip)
                PIP_EXTRA_URLS="${PIP_EXTRA_URLS} https://az:${AZURE_DEVOPS_PAT}@pkgs.dev.azure.com/${URL_ORG_PART}/_packaging/${FEED_FEED}/pypi/simple/"
                ;;
        esac
        echo "  Feed: ${FEED_NAME} (${FEED_TYPE}) -> ${URL_ORG_PART}/_packaging/${FEED_FEED}" >> /tmp/sandbox-debug.log
    done

    if [ -n "$NUGET_SOURCES" ]; then
        mkdir -p /home/sandbox/.nuget/NuGet
        printf "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<configuration>\n  <packageSources>\n%b  </packageSources>\n  <packageSourceCredentials>\n%b  </packageSourceCredentials>\n</configuration>\n" "$NUGET_SOURCES" "$NUGET_CREDS" > /home/sandbox/.nuget/NuGet/NuGet.Config
        chown -R sandbox:sandbox /home/sandbox/.nuget
        echo "NuGet.Config written" >> /tmp/sandbox-debug.log
    fi

    if [ -n "$NPM_LINES" ]; then
        printf "%b" "$NPM_LINES" > /home/sandbox/.npmrc
        chown sandbox:sandbox /home/sandbox/.npmrc
        echo ".npmrc written" >> /tmp/sandbox-debug.log
    fi

    if [ -n "$PIP_EXTRA_URLS" ]; then
        mkdir -p /home/sandbox/.config/pip
        printf "[global]\nextra-index-url =%s\n" "$PIP_EXTRA_URLS" > /home/sandbox/.config/pip/pip.conf
        chown -R sandbox:sandbox /home/sandbox/.config/pip
        echo "pip.conf written" >> /tmp/sandbox-debug.log
    fi
fi

# Clone repository if URL provided
WORK_DIR="/home/sandbox/projects"
mkdir -p "$WORK_DIR"
chown sandbox:sandbox "$WORK_DIR"

echo "REPO_URL: $REPO_URL" >> /tmp/sandbox-debug.log
echo "REPO_NAME: $REPO_NAME" >> /tmp/sandbox-debug.log
echo "REPO_BRANCH: $REPO_BRANCH" >> /tmp/sandbox-debug.log

if [ -n "$REPO_URL" ]; then
    echo "Cloning repository: $REPO_URL"
    REPO_NAME="${REPO_NAME:-repo}"
    REPO_BRANCH="${REPO_BRANCH:-main}"
    
    cd "$WORK_DIR"
    
    # Clone with --no-single-branch so new branches can be pushed and seen remotely
    echo "Attempting clone with branch $REPO_BRANCH..."
    if git clone --depth 1 --no-single-branch --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_NAME" 2>&1; then
        echo "Clone successful with branch $REPO_BRANCH"
    elif git clone --depth 1 --no-single-branch "$REPO_URL" "$REPO_NAME" 2>&1; then
        echo "Clone successful without branch"
    else
        echo "ERROR: Failed to clone repository" >> /tmp/sandbox-debug.log
        echo "Warning: Failed to clone repository"
    fi
    
    if [ -d "$WORK_DIR/$REPO_NAME" ]; then
        WORK_DIR="$WORK_DIR/$REPO_NAME"
        chown -R sandbox:sandbox "$WORK_DIR"
        echo "Repository cloned to: $WORK_DIR"
        echo "Clone successful: $WORK_DIR" >> /tmp/sandbox-debug.log
        # Ensure we're on REPO_BRANCH (e.g. PR branch). If clone used default, fetch and checkout.
        if [ -n "$REPO_BRANCH" ]; then
            cd "$WORK_DIR"
            current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
            if [ "$current_branch" != "$REPO_BRANCH" ]; then
                echo "Checking out branch $REPO_BRANCH..."
                # Remove untracked files (e.g. .rules) that would block checkout
                git clean -fd 2>/dev/null || true
                if git checkout "$REPO_BRANCH" 2>/dev/null; then
                    echo "Checked out existing $REPO_BRANCH"
                elif git fetch origin "$REPO_BRANCH" 2>/dev/null && git checkout "$REPO_BRANCH" 2>/dev/null; then
                    echo "Fetched and checked out $REPO_BRANCH"
                else
                    echo "Warning: could not checkout $REPO_BRANCH, staying on $current_branch" >> /tmp/sandbox-debug.log
                fi
            fi
            cd - >/dev/null
        fi
    fi
else
    echo "No REPO_URL provided, skipping clone" >> /tmp/sandbox-debug.log
fi

# Fallback: when clone was not used or failed, use GitHub archive (zipball) so code is available when git clone is blocked
REPO_NAME="${REPO_NAME:-repo}"
if [ -n "$REPO_ARCHIVE_URL" ] && [ ! -d "$WORK_DIR/$REPO_NAME" ] && [ ! -d "/home/sandbox/projects/$REPO_NAME" ]; then
    echo "REPO_ARCHIVE_URL: $REPO_ARCHIVE_URL" >> /tmp/sandbox-debug.log
    echo "Downloading repository from archive: $REPO_ARCHIVE_URL"
    cd /home/sandbox/projects
    if curl -sSfL -H "User-Agent: DevPilot" -o repo.zip "$REPO_ARCHIVE_URL" 2>>/tmp/sandbox-debug.log; then
        unzip -o -q repo.zip 2>>/tmp/sandbox-debug.log
        TOPDIR=$(ls -d */ 2>/dev/null | head -1)
        if [ -n "$TOPDIR" ]; then
            mv "${TOPDIR%/}" "$REPO_NAME"
            WORK_DIR="/home/sandbox/projects/$REPO_NAME"
            chown -R sandbox:sandbox "$WORK_DIR"
            echo "Repository extracted to: $WORK_DIR"
            echo "Archive download successful: $WORK_DIR" >> /tmp/sandbox-debug.log
        fi
        rm -f repo.zip
    else
        echo "ERROR: Failed to download repository archive" >> /tmp/sandbox-debug.log
        echo "Warning: Failed to download repository archive"
    fi
fi

# Launch Zed with software rendering and D-Bus
sleep 2
echo "Starting Zed with software rendering..."

# Source D-Bus environment
if [ -f /tmp/dbus-env.sh ]; then
    source /tmp/dbus-env.sh
    export DBUS_SESSION_BUS_ADDRESS
    echo "D-Bus sourced: $DBUS_SESSION_BUS_ADDRESS" >> /tmp/sandbox-debug.log
else
    echo "WARNING: D-Bus env file not found!" >> /tmp/sandbox-debug.log
fi

# Software rendering environment (suppresses GPU errors)
export LIBGL_ALWAYS_SOFTWARE=1
export MESA_GL_VERSION_OVERRIDE=4.5
export GALLIUM_DRIVER=llvmpipe
export MESA_LOADER_DRIVER_OVERRIDE=llvmpipe
export __GLX_VENDOR_LIBRARY_NAME=mesa

# CRITICAL: Explicitly select lavapipe (software Vulkan) device
# Without this, Zed fails with "VK_KHR_get_physical_device_properties2 not supported"
export MESA_VK_DEVICE_SELECT=10005:0

# Set ICD file - try generic name first, then architecture-specific
if [ -f /usr/share/vulkan/icd.d/lvp_icd.json ]; then
    export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json
else
    ARCH=$(uname -m)
    if [ "$ARCH" = "aarch64" ]; then
        export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.aarch64.json
    elif [ "$ARCH" = "x86_64" ]; then
        export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json
    fi
fi
export DISABLE_LAYER_AMD_SWITCHABLE_GRAPHICS_1=1

# Suppress Vulkan/GPU warnings
export VK_LOADER_DEBUG=none
export MESA_DEBUG=silent

# Ensure HOME is set correctly
export HOME=/home/sandbox

# Log API key status (not the actual key)
echo "OPENAI_API_KEY set: ${OPENAI_API_KEY:+yes}" >> /tmp/sandbox-debug.log
echo "OPENAI_API_BASE set: ${OPENAI_API_BASE:-not set}" >> /tmp/sandbox-debug.log
echo "ANTHROPIC_API_KEY set: ${ANTHROPIC_API_KEY:+yes}" >> /tmp/sandbox-debug.log
echo "Opening Zed in: $WORK_DIR" >> /tmp/sandbox-debug.log

# Create a .rules file only when custom agent rules are provided via AGENT_RULES env var
if [ -d "$WORK_DIR" ] && [ "$WORK_DIR" != "/home/sandbox/projects" ] && [ -n "$AGENT_RULES" ]; then
    RULES_FILE="$WORK_DIR/.rules"
    echo "$AGENT_RULES" > "$RULES_FILE"
    chown sandbox:sandbox "$RULES_FILE"
    echo "Agent rules written to: $RULES_FILE" >> /tmp/sandbox-debug.log
fi

# Open Zed in the project directory
echo "Launching Zed in: $WORK_DIR"

# Wait for X to be fully ready
sleep 3

# Create log files (start.sh runs as sandbox, so they'll be owned by sandbox)
touch /tmp/zed-stdout.log

# Create Zed launcher script
cat > /tmp/launch-zed.sh << ZEDLAUNCHER
#!/bin/bash
export DISPLAY=:0
export HOME=/home/sandbox

# SSL certificate environment variables (fixes SSL issues for LLM API calls)
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_DIR=/etc/ssl/certs
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export SSL_VERIFY=false
export GIT_SSL_NO_VERIFY=true

# Force software rendering with llvmpipe
export LIBGL_ALWAYS_SOFTWARE=1
export MESA_GL_VERSION_OVERRIDE=4.5
export GALLIUM_DRIVER=llvmpipe
export MESA_LOADER_DRIVER_OVERRIDE=llvmpipe

# CRITICAL: Explicitly select lavapipe (software Vulkan) device
# Without this, Zed fails with "VK_KHR_get_physical_device_properties2 not supported"
export MESA_VK_DEVICE_SELECT=10005:0

# Set ICD file - try generic name first, then architecture-specific
if [ -f /usr/share/vulkan/icd.d/lvp_icd.json ]; then
    export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json
else
    ARCH=\$(uname -m)
    if [ "\$ARCH" = "aarch64" ]; then
        export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.aarch64.json
    elif [ "\$ARCH" = "x86_64" ]; then
        export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json
    fi
fi

# Allow emulated GPU - skip the warning dialog
export ZED_ALLOW_EMULATED_GPU=1

# Force X11 (Zed may prefer Wayland; Xvfb is X11-only)
export GDK_BACKEND=x11
export QT_QPA_PLATFORM=xcb
unset WAYLAND_DISPLAY


# D-Bus setup
source /tmp/dbus-env.sh 2>/dev/null || true

# Disable keyring prompt
export GNOME_KEYRING_CONTROL=
export SECRET_SERVICE_BUS_NAME=

echo "Launching Zed at: \$(date)" >> /tmp/zed-stdout.log
exec /home/sandbox/.local/bin/zed "${WORK_DIR}" >> /tmp/zed-stdout.log 2>&1
ZEDLAUNCHER
chmod +x /tmp/launch-zed.sh

# Launch Zed directly (start.sh runs as sandbox user already)
chmod +x /tmp/launch-zed.sh
# Don't use 'script' wrapper - it causes Vulkan issues
/tmp/launch-zed.sh &
ZED_LAUNCHER_PID=\$!
echo "Zed launcher started as sandbox user with PID \$ZED_LAUNCHER_PID" >> /tmp/sandbox-debug.log

# NOTE: Auto dialog handling disabled - user handles dialogs manually if needed
echo "Zed launched, ready for prompts via Bridge API" >> /tmp/sandbox-debug.log

echo "Desktop ready on port 6080"
echo "Bridge API ready on port 8091"
echo "Zed launched in background"
echo "=== SANDBOX READY ===" >> /tmp/sandbox-debug.log

# Check if Zed is running (wait a moment for it to start)
sleep 3
ZED_PID=$(pgrep -f "zed-editor" || pgrep -f "/home/sandbox/.local/bin/zed" || echo "")
if [ -n "$ZED_PID" ]; then
    echo "Zed is running with PID: $ZED_PID" >> /tmp/sandbox-debug.log
    # Terminal panel will be opened after the first prompt is pasted (via /zed/send-prompt)
    # to avoid the terminal stealing focus and capturing the prompt text.
else
    echo "WARNING: Zed process not found, check /tmp/zed-stdout.log" >> /tmp/sandbox-debug.log
fi

echo "Sandbox ready - Bridge API available on port 8091" >> /tmp/sandbox-debug.log

# Keep container running
wait
DESKTOP_START

chmod +x desktop/start.sh

# Build desktop image
log_info "Building desktop image..."
docker build -t devpilot-desktop ./desktop

# ============================================================
# Create Sandbox Manager API
# ============================================================
log_info "Creating sandbox manager..."

cp "${SCRIPT_SOURCE_DIR}/manager/manager.py" manager.py

# ============================================================
# BUILD_ONLY mode — used by Windows Docker setup (setup.ps1)
# Exits here after building the desktop image and writing manager.py.
# The Windows setup starts the manager via docker-compose instead of systemd.
# ============================================================
if [ "${BUILD_ONLY:-0}" = "1" ]; then
    log_info "BUILD_ONLY mode complete — desktop image built, manager.py ready."
    log_info "Start the manager on Windows with: docker compose up -d"
    exit 0
fi

# ============================================================
# Create systemd service for the manager (Linux only)
# ============================================================
if [ "$IS_LINUX" = true ]; then
    log_info "Creating systemd service..."
    
    cat > /etc/systemd/system/devpilot-sandbox.service << SERVICE
[Unit]
Description=DevPilot Sandbox Manager
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$PROJECT_DIR/venv/bin/python $PROJECT_DIR/manager.py
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
EnvironmentFile=-$PROJECT_DIR/.env

[Install]
WantedBy=multi-user.target
SERVICE
    
    # Clean up broken/outdated third-party repositories
    log_info "Cleaning up broken apt repositories..."
    rm -f /etc/apt/sources.list.d/azlux.list 2>/dev/null || true
    rm -f /etc/apt/sources.list.d/log2ram.list 2>/dev/null || true
    
    # Install Python dependencies
    log_info "Installing Python dependencies..."
    apt-get update && apt-get install -y python3-pip python3-venv
else
    log_info "macOS detected - skipping systemd service"
fi

# Create virtual environment to avoid system package conflicts
python3 -m venv $PROJECT_DIR/venv
$PROJECT_DIR/venv/bin/pip install --upgrade pip \
    --trusted-host pypi.org \
    --trusted-host files.pythonhosted.org
$PROJECT_DIR/venv/bin/pip install \
    --trusted-host pypi.org \
    --trusted-host files.pythonhosted.org \
    flask flask-cors docker

# ============================================================
# Create management script (cross-platform)
# ============================================================
cat > run.sh << RUNSH
#!/bin/bash
PROJECT_DIR="$PROJECT_DIR"
IS_MACOS=$IS_MACOS

case "\${1:-help}" in
    start)
        if [ "\$IS_MACOS" = true ]; then
            cd "\$PROJECT_DIR"
            nohup \$PROJECT_DIR/venv/bin/python \$PROJECT_DIR/manager.py > \$PROJECT_DIR/manager.log 2>&1 &
            echo \$! > \$PROJECT_DIR/manager.pid
            echo "Manager started on port 8090 (PID: \$(cat \$PROJECT_DIR/manager.pid))"
        else
            systemctl start devpilot-sandbox
            echo "Manager started on port 8090"
        fi
        ;;
    stop)
        if [ "\$IS_MACOS" = true ]; then
            if [ -f "\$PROJECT_DIR/manager.pid" ]; then
                kill \$(cat \$PROJECT_DIR/manager.pid) 2>/dev/null || true
                rm -f \$PROJECT_DIR/manager.pid
            fi
            pkill -f "manager.py" 2>/dev/null || true
            echo "Manager stopped"
        else
            systemctl stop devpilot-sandbox
            echo "Manager stopped"
        fi
        ;;
    restart)
        \$0 stop
        sleep 1
        \$0 start
        ;;
    status)
        if [ "\$IS_MACOS" = true ]; then
            if pgrep -f "manager.py" > /dev/null; then
                echo "Manager is running"
                pgrep -f "manager.py"
            else
                echo "Manager is not running"
            fi
        else
            systemctl status devpilot-sandbox
        fi
        ;;
    logs)
        if [ "\$IS_MACOS" = true ]; then
            tail -f \$PROJECT_DIR/manager.log
        else
            journalctl -u devpilot-sandbox -f
        fi
        ;;
    rebuild)
        echo "Rebuilding desktop image (using cache)..."
        docker build -t devpilot-desktop ./desktop
        echo "Desktop image rebuilt"
        ;;
    force-rebuild)
        echo "Force rebuilding desktop image (no cache)..."
        echo "Stopping all sandbox containers..."
        docker ps -aq --filter "name=sandbox-" | xargs docker rm -f 2>/dev/null || true
        echo "Removing old desktop image..."
        docker rmi devpilot-desktop 2>/dev/null || true
        echo "Pruning Docker build cache..."
        docker builder prune -f 2>/dev/null || true
        echo "Building fresh image..."
        docker build --no-cache --pull -t devpilot-desktop ./desktop
        echo "Desktop image force rebuilt (no cache)"
        ;;
    clean-cache)
        echo "Cleaning Docker build cache..."
        docker builder prune -af
        echo "Removing dangling images..."
        docker image prune -f
        echo "Cache cleaned"
        ;;
    cleanup)
        docker ps -aq --filter "name=sandbox-" | xargs docker rm -f 2>/dev/null || true
        echo "All sandboxes removed"
        ;;
    *)
        echo "DevPilot Sandbox Manager"
        echo ""
        echo "Usage: \$0 [command]"
        echo ""
        echo "Commands:"
        echo "  start         - Start the manager"
        echo "  stop          - Stop the manager"
        echo "  restart       - Restart the manager"
        echo "  status        - Show status"
        echo "  logs          - View logs"
        echo "  rebuild       - Rebuild desktop image (uses cache)"
        echo "  force-rebuild - Rebuild desktop image (no cache, clean build)"
        echo "  clean-cache   - Clean Docker build cache"
        echo "  cleanup       - Remove all sandbox containers"
        ;;
esac
RUNSH
chmod +x run.sh

# ============================================================
# Generate .env with a random MANAGER_API_KEY (only if not already set)
# ============================================================
if [ -n "${MANAGER_API_KEY:-}" ]; then
    # Key provided via environment — write it to .env (overwrites any existing)
    log_info "Using MANAGER_API_KEY from environment"
    cat > "$PROJECT_DIR/.env" << ENVFILE
MANAGER_API_KEY=${MANAGER_API_KEY}
ENVFILE
    chmod 600 "$PROJECT_DIR/.env"
elif [ ! -f "$PROJECT_DIR/.env" ]; then
    log_info "Generating .env with random MANAGER_API_KEY..."
    GENERATED_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
    cat > "$PROJECT_DIR/.env" << ENVFILE
MANAGER_API_KEY=${GENERATED_KEY}
ENVFILE
    chmod 600 "$PROJECT_DIR/.env"
    log_info "API key saved to $PROJECT_DIR/.env"
else
    log_skip ".env already exists — keeping existing MANAGER_API_KEY"
fi

# ============================================================
# Start the service
# ============================================================
log_info "Starting sandbox manager..."
if [ "$IS_LINUX" = true ]; then
    systemctl daemon-reload
    systemctl enable devpilot-sandbox
    systemctl start devpilot-sandbox
else
    # macOS - start directly
    cd $PROJECT_DIR
    ./run.sh start
fi

# Get IP
if [ "$IS_MACOS" = true ]; then
    PUBLIC_IP="localhost"
else
    PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_VPS_IP")
fi

echo ""
echo "=========================================="
echo -e "${GREEN}✅ Setup complete!${NC}"
echo ""
echo "📌 Sandbox Manager API:"
echo -e "   ${GREEN}http://${PUBLIC_IP}:8090${NC}"
echo ""
echo "📌 API Endpoints:"
echo "   POST   /sandboxes          - Create new sandbox"
echo "   GET    /sandboxes          - List all sandboxes"
echo "   GET    /sandboxes/{id}     - Get sandbox status"
echo "   DELETE /sandboxes/{id}     - Delete sandbox"
echo ""
echo "📌 Example:"
echo "   curl -X POST http://${PUBLIC_IP}:8090/sandboxes \\"
echo "        -H 'X-Api-Key: \$(grep MANAGER_API_KEY $PROJECT_DIR/.env | cut -d= -f2)'"
echo ""
echo "🔧 Management:"
echo "   cd $PROJECT_DIR"
echo "   ./run.sh status"
echo "   ./run.sh logs"
echo ""
echo "🔑 Manager API Key (for backend config VPS:ManagerApiKey):"
echo "   \$(grep MANAGER_API_KEY $PROJECT_DIR/.env | cut -d= -f2)"
echo ""
echo "⚠️  Firewall: Open ports 8090 and 6100-6200"
echo "   ufw allow 8090/tcp"
echo "   ufw allow 6100:6200/tcp"
echo "=========================================="
