# DevPilot Sandbox

Multi-container sandbox system that creates isolated desktop environments on demand.
Each "Analyze with AI" click spawns a fresh, isolated Docker container.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        VPS                               │
│  ┌─────────────────────────────────────────────────────┐ │
│  │           Sandbox Manager (port 8090)               │ │
│  │                                                     │ │
│  │   POST /sandboxes → Creates new container           │ │
│  │   DELETE /sandboxes/{id} → Removes container        │ │
│  └─────────────────────────────────────────────────────┘ │
│                          │                               │
│            ┌─────────────┼─────────────┐                │
│            ▼             ▼             ▼                │
│     ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│     │ Sandbox  │  │ Sandbox  │  │ Sandbox  │           │
│     │  :6100   │  │  :6101   │  │  :6102   │  ...      │
│     │ (user A) │  │ (user B) │  │ (user C) │           │
│     └──────────┘  └──────────┘  └──────────┘           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### On your VPS:

```bash
# Download and run
curl -sSL https://raw.githubusercontent.com/YOUR_REPO/sandbox/setup.sh | sudo bash
```

### Configure Frontend:

Update `frontend/src/app/core/config/vps.config.ts`:

```typescript
export const VPS_CONFIG = {
  ip: 'YOUR_VPS_IP',
  novncPort: 6080,
  sandboxApiPort: 8090,
  password: ''
};
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/sandboxes` | List all active sandboxes |
| POST | `/sandboxes` | Create new sandbox |
| GET | `/sandboxes/{id}` | Get sandbox status |
| DELETE | `/sandboxes/{id}` | Delete sandbox |
| POST | `/sandboxes/{id}/stop` | Stop sandbox |

### Create Sandbox

```bash
curl -X POST http://YOUR_VPS_IP:8090/sandboxes
```

Response:
```json
{
  "id": "abc123",
  "port": 6100,
  "url": "http://YOUR_VPS_IP:6100/vnc.html",
  "status": "starting"
}
```

### List Sandboxes

```bash
curl http://YOUR_VPS_IP:8090/sandboxes
```

### Delete Sandbox

```bash
curl -X DELETE http://YOUR_VPS_IP:8090/sandboxes/abc123
```

## Management

```bash
cd /opt/devpilot-sandbox

./run.sh start     # Start manager
./run.sh stop      # Stop manager
./run.sh status    # Show status
./run.sh logs      # View logs
./run.sh rebuild   # Rebuild desktop image
./run.sh cleanup   # Remove all sandbox containers
```

## Ports

| Port | Service |
|------|---------|
| 8090 | Sandbox Manager API |
| 6100-6200 | Individual sandbox noVNC ports |

## Firewall

```bash
sudo ufw allow 8090/tcp
sudo ufw allow 6100:6200/tcp
```

## Features

- **Isolation**: Each sandbox runs in its own Docker container
- **Auto-cleanup**: Sandboxes older than 2 hours are automatically removed
- **Port management**: Automatic port allocation from pool (6100-6200)
- **Desktop environment**: XFCE + Zed IDE + Firefox
- **Browser access**: noVNC for web-based remote desktop

## Desktop Environment

Each sandbox includes:
- Ubuntu 24.04
- XFCE Desktop
- Zed IDE
- Firefox
- Terminal

## Maintenance Commands

### Service Management

```bash
# Check API service status
sudo systemctl status devpilot-sandbox

# Restart API service
sudo systemctl restart devpilot-sandbox

# Stop API service
sudo systemctl stop devpilot-sandbox

# Start API service
sudo systemctl start devpilot-sandbox

# View API logs (follow)
journalctl -u devpilot-sandbox -f

# View last 50 API log lines
journalctl -u devpilot-sandbox -n 50 --no-pager
```

### Container Cleanup

```bash
# List all sandbox containers
docker ps --filter "name=sandbox-"

# Stop all sandbox containers
docker stop $(docker ps -q --filter "name=sandbox-")

# Remove all sandbox containers (stopped and running)
docker rm -f $(docker ps -aq --filter "name=sandbox-")

# Full cleanup: stop + remove all sandbox containers
docker ps -q --filter "name=sandbox-" | xargs -r docker stop
docker ps -aq --filter "name=sandbox-" | xargs -r docker rm
```

### Image Management

```bash
# List sandbox images
docker images | grep devpilot

# Remove sandbox image (forces rebuild on next setup)
docker rmi devpilot-desktop

# Rebuild image
cd /opt/devpilot-sandbox
docker build -t devpilot-desktop ./desktop
```

### Volume Cleanup

```bash
# List all volumes
docker volume ls

# Remove unused volumes
docker volume prune -f

# Remove all unused Docker data (containers, images, volumes, networks)
docker system prune -af --volumes
```

### Full Reset

```bash
# Complete reset: stop service, remove all containers/images, rebuild
sudo systemctl stop devpilot-sandbox
docker rm -f $(docker ps -aq --filter "name=sandbox-") 2>/dev/null
docker rmi devpilot-desktop 2>/dev/null
docker volume prune -f
cd /opt/devpilot-sandbox
./setup.sh
sudo systemctl start devpilot-sandbox
```

### Quick Restart (after code changes)

```bash
# After updating setup.sh locally, copy and redeploy:
cd /opt/devpilot-sandbox
./setup.sh
sudo systemctl restart devpilot-sandbox
```

## Troubleshooting

### Check manager status
```bash
systemctl status devpilot-sandbox
```

### View logs
```bash
journalctl -u devpilot-sandbox -f
```

### Debug a running container
```bash
# Get container ID
docker ps --filter "name=sandbox-"

# View container logs
docker logs <container_id>

# Check environment variables
docker exec <container_id> env | grep -E "OPENAI|ZED|REPO|DEVPILOT"

# Check Zed settings
docker exec <container_id> cat /home/sandbox/.config/zed/settings.json

# Check debug log
docker exec <container_id> cat /tmp/sandbox-debug.log

# Check Zed errors
docker exec <container_id> cat /tmp/zed-errors.log

# Check if Zed is running
docker exec <container_id> ps aux | grep zed

# Open shell in container
docker exec -it <container_id> bash
```

### Common Issues

**Zed not starting:**
```bash
# Run Zed manually to see errors
docker exec -it <container_id> bash -c '
  source /tmp/dbus-env.sh
  export DISPLAY=:0 LIBGL_ALWAYS_SOFTWARE=1 HOME=/home/sandbox
  /home/sandbox/.local/bin/zed --foreground /home/sandbox/projects 2>&1
'
```

**Port already in use:**
```bash
# Find what's using the port
lsof -i :8090
netstat -tlnp | grep 8090

# Kill the process
kill -9 <PID>
```

**API not responding:**
```bash
# Check if service is running
systemctl status devpilot-sandbox

# Check if port is open
curl http://localhost:8090/health
```
