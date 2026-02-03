# VPS Sandbox Connection Guide

Complete guide to setting up the DevPilot sandbox environment on a VPS for AI-powered code implementation.

## Overview

The sandbox system provides isolated development environments where AI can implement user stories. Each sandbox is a Docker container with:

- Full Ubuntu 24.04 desktop (XFCE)
- Zed IDE with AI assistant configured
- Repository pre-cloned with credentials
- Browser-based access via noVNC
- Bridge API for git operations

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                              VPS                                     │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              Sandbox Manager (port 8090)                     │   │
│  │                                                              │   │
│  │   POST /sandboxes → Creates isolated container               │   │
│  │   DELETE /sandboxes/{id} → Removes container                 │   │
│  │   GET /sandboxes → Lists active sandboxes                    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                       │
│              ┌───────────────┼───────────────┐                      │
│              ▼               ▼               ▼                      │
│       ┌────────────┐  ┌────────────┐  ┌────────────┐               │
│       │  Sandbox 1 │  │  Sandbox 2 │  │  Sandbox 3 │  ...          │
│       │ noVNC:6100 │  │ noVNC:6101 │  │ noVNC:6102 │               │
│       │ Bridge:8091│  │ Bridge:8092│  │ Bridge:8093│               │
│       │            │  │            │  │            │               │
│       │ ┌────────┐ │  │ ┌────────┐ │  │ ┌────────┐ │               │
│       │ │Zed IDE │ │  │ │Zed IDE │ │  │ │Zed IDE │ │               │
│       │ │  + AI  │ │  │ │  + AI  │ │  │ │  + AI  │ │               │
│       │ └────────┘ │  │ └────────┘ │  │ └────────┘ │               │
│       └────────────┘  └────────────┘  └────────────┘               │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Ubuntu 22.04+ VPS with:
  - 4GB RAM minimum (8GB recommended)
  - 2 vCPUs minimum
  - 40GB disk space
  - Root access
- Open ports: 8090, 6100-6200

## Quick Setup

### 1. Connect to VPS

```bash
ssh root@YOUR_VPS_IP
```

### 2. Run Setup Script

```bash
# Download and run
curl -sSL https://raw.githubusercontent.com/YOUR_REPO/DevPilot/main/sandbox/setup.sh | sudo bash

# Or copy setup.sh to VPS and run:
sudo bash setup.sh
```

The script will:
- Install Docker
- Build the desktop image
- Configure the sandbox manager
- Set up systemd service

### 3. Configure Firewall

```bash
sudo ufw allow 8090/tcp    # Sandbox Manager API
sudo ufw allow 6100:6200/tcp  # noVNC ports for sandboxes
```

### 4. Verify Installation

```bash
# Check service status
sudo systemctl status devpilot-sandbox

# Test API
curl http://localhost:8090/health
```

## Configuration

### Backend Configuration

In `src/API/appsettings.Development.json`:

```json
{
  "VPS": {
    "GatewayUrl": "http://YOUR_VPS_IP:8090",
    "SessionTimeoutMinutes": 60,
    "Enabled": true
  }
}
```

### Frontend Configuration (Optional)

If you need direct VPS access, edit `frontend/src/app/core/config/vps.config.ts`:

```typescript
export const VPS_CONFIG = {
  ip: 'YOUR_VPS_IP',
  sandboxApiPort: 8090,
  password: ''  // Optional VNC password
};
```

## API Endpoints

### Sandbox Manager API (Port 8090)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/sandboxes` | List all active sandboxes |
| POST | `/sandboxes` | Create new sandbox |
| GET | `/sandboxes/{id}` | Get sandbox status |
| DELETE | `/sandboxes/{id}` | Delete sandbox |
| POST | `/sandboxes/{id}/stop` | Stop sandbox |

### Bridge API (Per-Sandbox, Port 8091+)

Each sandbox has its own Bridge API for internal operations:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Bridge health check |
| GET | `/git/status` | Git repository status |
| POST | `/git/push-and-create-pr` | Push changes and prepare PR |
| POST | `/zed/message` | Send message to Zed AI |
| GET | `/zed/conversations` | Get AI conversation history |

## Creating a Sandbox

### Request

```bash
curl -X POST http://YOUR_VPS_IP:8090/sandboxes \
  -H "Content-Type: application/json" \
  -d '{
    "repo_url": "https://TOKEN@github.com/user/repo.git",
    "repo_name": "repo",
    "repo_branch": "main",
    "ai_config": {
      "provider": "openai",
      "api_key": "sk-...",
      "model": "gpt-4"
    }
  }'
```

### Response

```json
{
  "id": "abc123",
  "port": 6100,
  "bridge_port": 8091,
  "url": "http://YOUR_VPS_IP:6100/vnc.html",
  "status": "starting"
}
```

## Managing Sandboxes

### Service Commands

```bash
# Start service
sudo systemctl start devpilot-sandbox

# Stop service
sudo systemctl stop devpilot-sandbox

# Restart service
sudo systemctl restart devpilot-sandbox

# View logs
sudo journalctl -u devpilot-sandbox -f
```

### Container Commands

```bash
# List sandbox containers
docker ps --filter "name=sandbox-"

# View container logs
docker logs sandbox-abc123

# Shell into container
docker exec -it sandbox-abc123 bash

# Stop all sandboxes
docker stop $(docker ps -q --filter "name=sandbox-")

# Remove all sandboxes
docker rm -f $(docker ps -aq --filter "name=sandbox-")
```

### Cleanup Commands

```bash
# Remove unused images
docker image prune -f

# Remove unused volumes
docker volume prune -f

# Full system cleanup
docker system prune -af --volumes
```

## Sandbox Features

### Desktop Environment

- **XFCE**: Lightweight desktop environment
- **Zed IDE**: Modern code editor with AI integration
- **Firefox**: Web browser for documentation
- **Terminal**: For manual git operations

### AI Integration

Zed IDE is pre-configured with:
- AI assistant panel
- Provider credentials from request
- Repository context loaded

### Git Operations

The Bridge API handles:
- Pushing changes to new branches
- Preparing PR metadata
- Credentials management (token in remote URL)

## Troubleshooting

### Service Won't Start

```bash
# Check logs
sudo journalctl -u devpilot-sandbox -n 50

# Check if port is in use
lsof -i :8090

# Kill process using port
kill -9 $(lsof -t -i:8090)
```

### Container Won't Start

```bash
# Check Docker logs
docker logs sandbox-abc123

# Check if image exists
docker images | grep devpilot-desktop

# Rebuild image
cd /opt/devpilot-sandbox
docker build -t devpilot-desktop ./desktop
```

### Zed Not Starting

```bash
# Check Zed logs
docker exec sandbox-abc123 cat /tmp/zed-errors.log

# Check if X server is running
docker exec sandbox-abc123 ps aux | grep Xvfb

# Manual Zed test
docker exec -it sandbox-abc123 bash -c '
  source /tmp/dbus-env.sh
  export DISPLAY=:0 LIBGL_ALWAYS_SOFTWARE=1
  /home/sandbox/.local/bin/zed --foreground /home/sandbox/projects 2>&1
'
```

### Git Push Fails

```bash
# Check git remote URL
docker exec sandbox-abc123 git -C /home/sandbox/projects/repo remote -v

# Check if credentials are embedded
# URL should be: https://TOKEN@github.com/...

# Manual push test
docker exec -it sandbox-abc123 bash -c '
  cd /home/sandbox/projects/repo
  git push origin HEAD
'
```

### noVNC Not Loading

```bash
# Check if noVNC process is running
docker exec sandbox-abc123 ps aux | grep novnc

# Check noVNC logs
docker logs sandbox-abc123 2>&1 | grep novnc

# Verify port mapping
docker port sandbox-abc123
```

## Security Considerations

1. **Firewall**: Only expose necessary ports (8090, 6100-6200)
2. **Credentials**: Tokens are passed at runtime, not stored on disk
3. **Isolation**: Each sandbox is a separate Docker container
4. **Cleanup**: Sandboxes auto-delete after 2 hours
5. **Network**: Consider using a VPN for VPS access

## Performance Tuning

### For Better Performance

```bash
# Increase Docker memory limit
# Edit /etc/docker/daemon.json
{
  "default-ulimits": {
    "memlock": { "Name": "memlock", "Hard": -1, "Soft": -1 }
  }
}

# Restart Docker
sudo systemctl restart docker
```

### Resource Limits Per Sandbox

Edit `setup.sh` to adjust container limits:

```python
# In the create_sandbox function
container = docker.run(
    ...,
    mem_limit='2g',      # Memory limit
    cpu_quota=100000,    # CPU limit (100% of 1 core)
    ...
)
```

## Maintenance

### Daily

- Check `docker ps` for orphaned containers
- Monitor disk space: `df -h`

### Weekly

- Run `docker system prune -f` to clean unused resources
- Check logs for errors: `journalctl -u devpilot-sandbox --since "1 week ago"`

### Monthly

- Update base image: `docker pull ubuntu:24.04`
- Rebuild desktop image with updates
- Review and rotate any stored credentials
