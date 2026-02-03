# VPS Quick Start Guide

Get DevPilot sandboxes running in 5 minutes.

## Prerequisites

- Ubuntu 22.04+ VPS (4GB RAM, 2 vCPU minimum)
- Root/sudo access
- Ports 8090 and 6100-6200 available

## Setup Steps

### 1. Connect to VPS

```bash
ssh root@YOUR_VPS_IP
```

### 2. Run Installation Script

```bash
# Download and run setup
curl -sSL https://raw.githubusercontent.com/YOUR_REPO/DevPilot/main/sandbox/setup.sh | sudo bash
```

This installs Docker, builds the desktop image, and starts the sandbox manager.

### 3. Open Firewall Ports

```bash
sudo ufw allow 8090/tcp
sudo ufw allow 6100:6200/tcp
```

### 4. Verify Installation

```bash
# Check status
sudo systemctl status devpilot-sandbox

# Test API
curl http://localhost:8090/health
```

Expected response: `{"status": "ok"}`

### 5. Configure DevPilot Backend

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

## Useful Commands

```bash
# View logs
sudo journalctl -u devpilot-sandbox -f

# Restart service
sudo systemctl restart devpilot-sandbox

# List sandboxes
curl http://YOUR_VPS_IP:8090/sandboxes

# Clean up containers
docker rm -f $(docker ps -aq --filter "name=sandbox-")
```

## Troubleshooting

**Service won't start:**
```bash
sudo journalctl -u devpilot-sandbox -n 50
```

**Port blocked:**
```bash
sudo ufw allow 8090/tcp
```

**Docker permission error:**
```bash
sudo usermod -aG docker $USER
newgrp docker
```

## Next Steps

See [VPS_SANDBOX_CONNECTION_GUIDE.md](VPS_SANDBOX_CONNECTION_GUIDE.md) for detailed configuration.
