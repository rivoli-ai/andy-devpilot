# DevPilot Sandbox — Linux Setup

Deploy the sandbox manager on a **Linux VPS** as a systemd service.

## Prerequisites

- Ubuntu 22.04 / 24.04 (recommended)
- Root access (`sudo`)
- Ports open: `8090`, `6100–6200`, `7100–7200`
- Docker will be installed automatically if not present

## Quick Start

```bash
# From the repo root
sudo bash infra/sandbox/linux/setup.sh

# Or directly on your VPS (download and run)
curl -sSL https://raw.githubusercontent.com/YOUR_ORG/andy-devpilot/main/infra/sandbox/setup.sh | sudo bash
```

## What it does

1. Installs Docker (if not already installed)
2. Creates project directory at `/opt/devpilot-sandbox/`
3. Generates `MANAGER_API_KEY` in `/opt/devpilot-sandbox/.env`
4. Copies custom certificates from `infra/sandbox/certs/` into the Docker build context
5. Builds the `devpilot-desktop` Docker image (~10-20 min first time)
6. Installs and starts a **systemd service** (`devpilot-sandbox`)

## After setup

### Retrieve the API key

```bash
sudo cat /opt/devpilot-sandbox/.env
# MANAGER_API_KEY=<your_key>
```

### Configure the backend

In `backend/src/API/appsettings.json`:

```json
"VPS": {
  "GatewayUrl": "http://YOUR_VPS_IP:8090",
  "ManagerApiKey": "<MANAGER_API_KEY>",
  "PublicIp": "YOUR_VPS_PUBLIC_IP",
  "Enabled": true
}
```

## Service management

```bash
# Status
sudo systemctl status devpilot-sandbox

# Live logs
journalctl -u devpilot-sandbox -f

# Restart
sudo systemctl restart devpilot-sandbox

# Stop
sudo systemctl stop devpilot-sandbox
```

Or use the helper script installed at `/opt/devpilot-sandbox/run.sh`:

```bash
cd /opt/devpilot-sandbox
sudo ./run.sh status
sudo ./run.sh logs
sudo ./run.sh rebuild   # rebuild desktop image
sudo ./run.sh cleanup   # remove all sandbox containers
```

## Firewall

```bash
# Allow sandbox ports (adjust if you use a different firewall)
sudo ufw allow 8090/tcp          # manager API  (restrict to backend IP if possible)
sudo ufw allow 6100:6200/tcp     # noVNC per sandbox
sudo ufw allow 7100:7200/tcp     # Bridge API per sandbox
sudo ufw reload
```

> **Security tip:** Port 8090 should only accept connections from your backend server IP.  
> Example: `sudo ufw allow from <BACKEND_IP> to any port 8090`

## Re-deploy after code changes

```bash
# Pull latest and re-run setup
git pull
sudo bash infra/sandbox/linux/setup.sh
```

The script stops the service, rebuilds the image, and restarts everything.

## Corporate proxy / Zscaler certificates

Place your `.crt` files in `infra/sandbox/certs/` **before** running setup.  
See `infra/sandbox/certs/README.md` for instructions.

## Troubleshooting

```bash
# Manager not responding
curl http://localhost:8090/health
sudo systemctl status devpilot-sandbox

# View container logs
docker logs <container_id>

# Open shell inside a sandbox
docker exec -it <container_id> bash

# Full reset
sudo systemctl stop devpilot-sandbox
docker rm -f $(docker ps -aq --filter "name=sandbox-") 2>/dev/null
docker rmi devpilot-desktop 2>/dev/null
sudo bash infra/sandbox/linux/setup.sh
```
