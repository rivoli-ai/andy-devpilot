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

# Check root (only on Linux)
if [ "$IS_LINUX" = true ] && [ "$EUID" -ne 0 ]; then 
    log_error "Please run as root: sudo ./setup.sh"
    exit 1
fi

# ============================================================
# FULL CLEANUP - Remove everything and start fresh
# ============================================================
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

# Create Zed installation script (separate file to avoid escaping issues in Dockerfile)
cat > desktop/install-zed.sh << 'INSTALL_ZED_SCRIPT'
#!/bin/bash
set -e

ARCH=$(uname -m)
echo "=== Zed Installation ==="
echo "Architecture: $ARCH"

mkdir -p /home/sandbox/.local/bin

if [ "$ARCH" != "x86_64" ]; then
    echo "WARNING: Zed only supports x86_64 (amd64) architecture."
    echo "Current architecture: $ARCH"
    echo "Zed will NOT be installed. Creating placeholder..."
    cat > /home/sandbox/.local/bin/zed << 'PLACEHOLDER'
#!/bin/bash
echo "Zed is not available on this architecture ($(uname -m))."
echo "Please use VS Code or another editor."
PLACEHOLDER
    chmod +x /home/sandbox/.local/bin/zed
    exit 0
fi

echo "Installing Zed for x86_64..."
curl -fsSL https://zed.dev/install.sh -o /tmp/zed-install.sh
chmod +x /tmp/zed-install.sh

if /tmp/zed-install.sh 2>&1 | tee /tmp/zed-install.log; then
    echo "=== Zed installation completed ==="
    if [ -f /home/sandbox/.local/bin/zed ]; then
        /home/sandbox/.local/bin/zed --version 2>/dev/null || echo "Zed binary exists but version check failed"
    else
        echo "Zed binary not found at expected location, checking..."
        ls -la /home/sandbox/.local/bin/ 2>/dev/null || true
    fi
else
    echo "=== Zed Installation FAILED ==="
    echo "Check /tmp/zed-install.log for details:"
    cat /tmp/zed-install.log
    echo "Creating placeholder script..."
    cat > /home/sandbox/.local/bin/zed << 'PLACEHOLDER'
#!/bin/bash
echo "Zed installation failed. Check /tmp/zed-install.log for details."
PLACEHOLDER
    chmod +x /home/sandbox/.local/bin/zed
fi

rm -f /tmp/zed-install.sh
echo "=== Zed setup complete ==="
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
    sudo wget curl git ca-certificates \
    python3 python3-pip python3-venv dbus-x11 \
    fonts-dejavu fonts-liberation \
    libxkbcommon0 libvulkan1 libasound2t64 libgbm1 \
    mesa-utils libgl1-mesa-dri libegl1 libgles2 \
    mesa-vulkan-drivers \
    xdotool wmctrl xclip xsel \
    xdg-desktop-portal xdg-desktop-portal-gtk \
    xdg-utils bzip2 xz-utils \
    gnome-keyring libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*

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

# Configure nginx to proxy noVNC - remove all iframe-blocking headers
RUN echo 'server { \
    listen 6080; \
    location / { \
        proxy_pass http://127.0.0.1:6081; \
        proxy_http_version 1.1; \
        proxy_set_header Upgrade $http_upgrade; \
        proxy_set_header Connection "upgrade"; \
        proxy_set_header Host $host; \
        proxy_set_header X-Real-IP $remote_addr; \
        proxy_hide_header X-Frame-Options; \
        proxy_hide_header Content-Security-Policy; \
        proxy_hide_header X-Content-Type-Options; \
        add_header Access-Control-Allow-Origin "*" always; \
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always; \
        add_header Access-Control-Allow-Headers "*" always; \
    } \
}' > /etc/nginx/sites-available/novnc && \
    ln -sf /etc/nginx/sites-available/novnc /etc/nginx/sites-enabled/novnc && \
    rm -f /etc/nginx/sites-enabled/default

USER sandbox
WORKDIR /home/sandbox

# Install Zed IDE with architecture check and proper error handling
COPY --chmod=755 install-zed.sh /tmp/install-zed.sh
RUN /tmp/install-zed.sh && rm -f /tmp/install-zed.sh
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
CORS(app)

# Configuration from environment
API_KEY = os.environ.get('OPENAI_API_KEY', '')
API_BASE = os.environ.get('OPENAI_API_BASE', 'https://api.openai.com/v1')
MODEL = os.environ.get('DEVPILOT_MODEL', 'gpt-4o')
PROJECT_PATH = os.environ.get('DEVPILOT_PROJECT_PATH', '/home/sandbox/projects')

# Conversation history
conversation_history = []

try:
    from openai import OpenAI
    client = OpenAI(api_key=API_KEY, base_url=API_BASE) if API_KEY else None
except ImportError:
    client = None
    logger.error("OpenAI package not installed")

# Store all Zed conversations (for frontend access)
zed_conversations = []

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
                full_text_response = ""
                has_tool_calls = False
                tool_calls_buffer = []  # Buffer to collect tool call chunks
                
                try:
                    response = http_requests.post(
                        f"{API_BASE}/chat/completions",
                        headers=headers,
                        json=payload,
                        timeout=300,  # Longer timeout for tool execution
                        stream=True
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
            response = http_requests.post(
                f"{API_BASE}/chat/completions",
                headers=headers,
                json=payload,
                timeout=300
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
        "count": len(all_convs)
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

@app.route('/zed/open-agent', methods=['POST'])
def zed_open_agent():
    """Open Zed's agent panel using xdotool"""
    import time
    try:
        window_id = None
        for attempt in range(6):
            window_id = find_zed_window()
            if window_id:
                break
            if attempt < 5:
                time.sleep(3)
        
        if not window_id:
            return jsonify({"error": "Zed window not found"}), 404
        
        env = {**os.environ, 'DISPLAY': ':0'}
        
        # Focus and send keystroke
        subprocess.run(['xdotool', 'windowactivate', '--sync', window_id], env=env)
        time.sleep(0.3)
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+shift+question'], env=env)
        
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
        # Retry finding Zed window (Zed can take 20-30s to show window with software rendering)
        window_id = None
        for attempt in range(8):
            window_id = find_zed_window()
            if window_id:
                break
            if attempt < 7:
                logger.info(f"Zed window not found yet, retry {attempt + 1}/8 in 3s...")
                time.sleep(3)
        
        if not window_id:
            logger.error("Zed window not found after retries!")
            return jsonify({"error": "Zed window not found"}), 404
        
        logger.info(f"Found Zed window: {window_id}")
        env = {**os.environ, 'DISPLAY': ':0'}
        
        import time
        
        # Step 1: Focus Zed window
        logger.info("Step 1: Focusing Zed window...")
        subprocess.run(['xdotool', 'windowactivate', '--sync', window_id], env=env)
        time.sleep(0.3)
        
        # Step 2: Press Escape to close any dialogs/panels and ensure clean state
        logger.info("Step 2: Pressing Escape to clear state...")
        subprocess.run(['xdotool', 'key', 'Escape'], env=env)
        time.sleep(0.2)
        
        # Step 3: Open the agent panel fresh with Ctrl+Shift+?
        # This ensures we're starting with an open panel
        logger.info("Step 3: Opening agent panel (Ctrl+Shift+?)...")
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+shift+question'], env=env)
        time.sleep(0.8)
        
        # Step 4: Focus should now be in the agent input. 
        # Press End to go to end of any existing text, then select all and delete
        logger.info("Step 4: Preparing input area...")
        subprocess.run(['xdotool', 'key', 'End'], env=env)
        time.sleep(0.1)
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+a'], env=env)
        time.sleep(0.1)
        subprocess.run(['xdotool', 'key', 'BackSpace'], env=env)
        time.sleep(0.2)
        
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
        time.sleep(0.1)
        
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

if __name__ == '__main__':
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

# Log version and environment variables for debugging
echo "=== DevPilot Sandbox v2.1.0 ===" > /tmp/sandbox-debug.log
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

# Start VNC server
x11vnc -display $DISPLAY -forever -shared -rfbport 5900 -nopw -xkb &
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
    "env": {
      "LIBGL_ALWAYS_SOFTWARE": "1"
    }
  },
  "worktree": {
    "trust_by_default": true
  }
}
ZEDSETTINGS
fi

chmod 644 /home/sandbox/.config/zed/settings.json
# Files are already owned by sandbox since start.sh runs as sandbox user
echo "Zed settings written:" >> /tmp/sandbox-debug.log
cat /home/sandbox/.config/zed/settings.json >> /tmp/sandbox-debug.log

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

# Create a .rules file in the project to guide the AI agent
if [ -d "$WORK_DIR" ] && [ "$WORK_DIR" != "/home/sandbox/projects" ]; then
    RULES_FILE="$WORK_DIR/.rules"
    if [ ! -f "$RULES_FILE" ]; then
        echo "Creating .rules file for AI agent..."
        cat > "$RULES_FILE" << 'RULES_CONTENT'
# DevPilot AI Agent Instructions

You are an AI assistant helping to analyze and improve this codebase.

## Your Role
- Analyze the project structure and understand the codebase
- Identify potential improvements, bugs, or security issues
- Suggest best practices and optimizations
- Help with code reviews and documentation

## When Starting
1. First, explore the project structure to understand the codebase
2. Read README.md if it exists
3. Identify the main technologies and frameworks used
4. Look for configuration files (package.json, pom.xml, requirements.txt, etc.)

## Guidelines
- Be concise and actionable in your suggestions
- Prioritize security and performance issues
- Follow the existing code style and conventions
- Explain your reasoning when making suggestions
RULES_CONTENT
        chown sandbox:sandbox "$RULES_FILE"
        echo ".rules file created at: $RULES_FILE" >> /tmp/sandbox-debug.log
    fi
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

# Clear any LD_PRELOAD that might interfere
export LD_PRELOAD=

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

cat > manager.py << 'MANAGER_PY'
#!/usr/bin/env python3
"""
DevPilot Sandbox Manager
Simple API to create/destroy isolated desktop containers
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
import docker
import uuid
import threading
import time

app = Flask(__name__)
CORS(app)

client = docker.from_env()

# Track active sandboxes: {sandbox_id: {container_id, port, created_at}}
sandboxes = {}
PORT_START = 6100
PORT_END = 6200
used_ports = set()
lock = threading.Lock()

def get_free_port():
    """Get next available port"""
    with lock:
        for port in range(PORT_START, PORT_END):
            if port not in used_ports:
                used_ports.add(port)
                return port
    return None

def release_port(port):
    """Release a port back to the pool"""
    with lock:
        used_ports.discard(port)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok"})

@app.route('/sandboxes', methods=['GET'])
def list_sandboxes():
    """List all active sandboxes"""
    result = []
    for sid, info in sandboxes.items():
        try:
            container = client.containers.get(info['container_id'])
            result.append({
                "id": sid,
                "port": info['port'],
                "status": container.status,
                "created_at": info['created_at']
            })
        except:
            pass
    return jsonify({"sandboxes": result})

@app.route('/sandboxes', methods=['POST'])
def create_sandbox():
    """Create a new isolated sandbox with optional repo and AI config"""
    import json
    
    # Log incoming request
    print("=" * 50)
    print("CREATE SANDBOX REQUEST")
    print("=" * 50)
    print(f"Request JSON: {request.json}")
    print("=" * 50)
    
    sandbox_id = str(uuid.uuid4())[:8]
    port = get_free_port()
    
    if not port:
        return jsonify({"error": "No ports available"}), 503
    
    try:
        data = request.json or {}
        
        # Build environment variables
        environment = {
            "SANDBOX_ID": sandbox_id,
            "RESOLUTION": data.get("resolution", "1920x1080x24")
        }
        
        # Add repository info if provided
        repo_url = data.get("repo_url", "")
        github_token = data.get("github_token", "")
        
        # If GitHub token is provided, inject it into the URL for authentication
        if repo_url and github_token and "github.com" in repo_url:
            # Convert https://github.com/user/repo.git to https://TOKEN@github.com/user/repo.git
            repo_url = repo_url.replace("https://github.com/", f"https://{github_token}@github.com/")
        
        if repo_url:
            environment["REPO_URL"] = repo_url
        if data.get("repo_name"):
            environment["REPO_NAME"] = data["repo_name"]
        if data.get("repo_branch"):
            environment["REPO_BRANCH"] = data["repo_branch"]
        
        # Add AI config - use environment variables for API keys (avoids keychain issues)
        if data.get("ai_config"):
            ai = data["ai_config"]
            provider = ai.get("provider", "openai")
            model = ai.get("model", "gpt-4o")
            api_key = ai.get("api_key", "")
            base_url = ai.get("base_url", "")
            
            # Set DevPilot environment variables
            environment["DEVPILOT_MODEL"] = model
            environment["DEVPILOT_PROVIDER"] = provider
            
            # Set API key as environment variable (Zed reads these automatically)
            if api_key:
                if provider == "openai":
                    environment["OPENAI_API_KEY"] = api_key
                elif provider == "anthropic":
                    environment["ANTHROPIC_API_KEY"] = api_key
                elif provider == "custom":
                    # For custom providers, use OPENAI_API_KEY with custom base URL
                    environment["OPENAI_API_KEY"] = api_key
                    if base_url:
                        environment["OPENAI_API_BASE"] = base_url
            
            # Use zed_settings from frontend if provided (includes theme, fonts, etc.)
            # Otherwise build minimal settings
            if data.get("zed_settings"):
                # Frontend sent complete settings, use them directly (formatted)
                environment["ZED_SETTINGS_JSON"] = json.dumps(data["zed_settings"], indent=2)
            else:
                # Build Zed settings (2025 format - uses "agent" not "assistant")
                # For custom providers, use "openai" as the provider type with custom base URL
                zed_provider = "openai" if provider == "custom" else provider
                
                settings = {
                    "theme": "One Dark",
                    "ui_font_size": 14,
                    "buffer_font_size": 14,
                    "agent": {
                        "enabled": True,
                        "default_model": {
                            "provider": zed_provider,
                            "model": model
                        },
                        "always_allow_tool_actions": True
                    },
                    "features": {"edit_prediction_provider": "zed"},
                    "terminal": {"env": {"LIBGL_ALWAYS_SOFTWARE": "1"}},
                    "worktree": {
                        "trust_by_default": True
                    }
                }
                
                # Configure language models for Zed's built-in agent
                if provider == "ollama":
                    settings["language_models"] = {
                        "ollama": {"api_url": ai.get("base_url", "http://localhost:11434")}
                    }
                else:
                    # Route through Bridge API proxy (captures conversations for frontend)
                    settings["language_models"] = {
                        "openai": {
                            "api_url": "http://localhost:8091/v1",
                            "available_models": [
                                {"name": model, "display_name": model, "max_tokens": 128000}
                            ]
                        }
                    }
                
                # Note: DevPilot agent server removed - using Bridge API proxy instead
                # The proxy at http://localhost:8091/v1 captures all conversations
                
                environment["ZED_SETTINGS_JSON"] = json.dumps(settings, indent=2)
        elif data.get("zed_settings"):
            environment["ZED_SETTINGS_JSON"] = json.dumps(data["zed_settings"], indent=2)
        
        # Log environment variables (hide sensitive data)
        safe_env = {k: ('***' if 'KEY' in k or 'TOKEN' in k else v) for k, v in environment.items()}
        print(f"Environment variables: {safe_env}")
        
        # Calculate bridge API port (VNC port + 1000, e.g., 6100 -> 7100)
        bridge_port = port + 1000
        
        container = client.containers.run(
            "devpilot-desktop",
            name=f"sandbox-{sandbox_id}",
            detach=True,
            remove=False,
            ports={
                '6080/tcp': port,
                '8091/tcp': bridge_port
            },
            shm_size="512m",
            environment=environment
        )
        
        sandboxes[sandbox_id] = {
            "container_id": container.id,
            "port": port,
            "bridge_port": bridge_port,
            "created_at": time.time()
        }
        
        return jsonify({
            "id": sandbox_id,
            "port": port,
            "bridge_port": bridge_port,
            "url": f"http://HOST_IP:{port}/vnc.html",
            "bridge_url": f"http://HOST_IP:{bridge_port}",
            "status": "starting"
        }), 201
        
    except Exception as e:
        release_port(port)
        return jsonify({"error": str(e)}), 500

@app.route('/sandboxes/<sandbox_id>', methods=['GET'])
def get_sandbox(sandbox_id):
    """Get sandbox status"""
    if sandbox_id not in sandboxes:
        return jsonify({"error": "Sandbox not found"}), 404
    
    info = sandboxes[sandbox_id]
    try:
        container = client.containers.get(info['container_id'])
        return jsonify({
            "id": sandbox_id,
            "port": info['port'],
            "status": container.status
        })
    except:
        return jsonify({"error": "Container not found"}), 404

@app.route('/sandboxes/<sandbox_id>', methods=['DELETE'])
def delete_sandbox(sandbox_id):
    """Stop and remove a sandbox"""
    if sandbox_id not in sandboxes:
        return jsonify({"error": "Sandbox not found"}), 404
    
    info = sandboxes[sandbox_id]
    try:
        container = client.containers.get(info['container_id'])
        container.stop(timeout=5)
        container.remove()
    except:
        pass
    
    release_port(info['port'])
    del sandboxes[sandbox_id]
    
    return jsonify({"status": "deleted"})

@app.route('/sandboxes/<sandbox_id>/stop', methods=['POST'])
def stop_sandbox(sandbox_id):
    """Stop a sandbox (keep container)"""
    if sandbox_id not in sandboxes:
        return jsonify({"error": "Sandbox not found"}), 404
    
    info = sandboxes[sandbox_id]
    try:
        container = client.containers.get(info['container_id'])
        container.stop(timeout=5)
        return jsonify({"status": "stopped"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Cleanup old sandboxes (>2 hours)
def cleanup_old_sandboxes():
    while True:
        time.sleep(300)  # Check every 5 min
        now = time.time()
        to_delete = []
        for sid, info in sandboxes.items():
            if now - info['created_at'] > 7200:  # 2 hours
                to_delete.append(sid)
        for sid in to_delete:
            try:
                info = sandboxes[sid]
                container = client.containers.get(info['container_id'])
                container.stop(timeout=5)
                container.remove()
                release_port(info['port'])
                del sandboxes[sid]
                print(f"Cleaned up sandbox {sid}")
            except:
                pass

if __name__ == '__main__':
    # Start cleanup thread
    threading.Thread(target=cleanup_old_sandboxes, daemon=True).start()
    
    print("DevPilot Sandbox Manager starting on port 8090...")
    app.run(host='0.0.0.0', port=8090)
MANAGER_PY

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
echo "   curl -X POST http://${PUBLIC_IP}:8090/sandboxes"
echo ""
echo "🔧 Management:"
echo "   cd $PROJECT_DIR"
echo "   ./run.sh status"
echo "   ./run.sh logs"
echo ""
echo "⚠️  Firewall: Open ports 8090 and 6100-6200"
echo "   ufw allow 8090/tcp"
echo "   ufw allow 6100:6200/tcp"
echo "=========================================="
