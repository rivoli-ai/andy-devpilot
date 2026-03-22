# DevPilot Sandbox — Windows Setup

Run the sandbox system on Windows using Docker Desktop **without WSL**.

## How it works

On Linux, `setup.sh` installs the sandbox manager as a **systemd service**.  
On Windows, this setup replaces that with a **Docker container** running the manager — no WSL terminal needed.

```
PowerShell (setup.ps1)
       │
       ├── Builds devpilot-desktop image
       │   └── Runs setup.sh inside a Linux Docker container (BUILD_ONLY=1)
       │       └── docker build uses the Windows Docker Desktop named pipe
       │
       └── Starts manager container (docker-compose)
               └── manager.py → mounts \\.\pipe\docker_engine
                   └── Creates/destroys sandbox containers on demand
```

## Prerequisites

- **Docker Desktop for Windows** (Hyper-V or WSL2 backend — both work)
  - Download: https://www.docker.com/products/docker-desktop
  - Enable "Use the WSL 2 based engine" OR keep Hyper-V (both work)
  - Make sure **Linux containers** mode is selected (default)
- **PowerShell 5.1+** (included in Windows 10/11)
- Ports **8090**, **6100–6200**, **7100–7200** free on your machine

## Quick Start

Open **PowerShell** (not CMD) in the repo root:

```powershell
# First time setup (builds the desktop image — takes 10-20 min)
.\infra\sandbox\windows\setup.ps1

# If the backend runs on a different machine or you need a specific IP
.\infra\sandbox\windows\setup.ps1 -HostIP 192.168.1.50

# Force a full rebuild of the desktop image
.\infra\sandbox\windows\setup.ps1 -Rebuild
```

If you get a script execution error, run this first:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

## What setup.ps1 does

1. **Checks Docker Desktop** is running
2. **Builds `devpilot-desktop`** by running `setup.sh` inside a temporary Linux container that mounts the Docker named pipe (`\\.\pipe\docker_engine`) — this builds the image on your host Docker without WSL
3. **Configures the API key** — uses `$env:MANAGER_API_KEY` if set, reuses existing `windows/.env` if present, otherwise generates a new key
4. **Starts the manager** container via `docker compose up`
5. **Health checks** the manager at `http://localhost:8090/health`

## Configure the backend

After running setup, update `backend/src/API/appsettings.Development.json`:

```json
"VPS": {
  "GatewayUrl": "http://localhost:8090",
  "ManagerApiKey": "<key shown in setup output>",
  "PublicIp": "localhost",
  "Enabled": true
}
```

The API key is also saved in `windows/.env` (gitignored).

## Day-to-day management

```powershell
# Start the manager (after PC restart)
docker compose -f infra\sandbox\windows\docker-compose.yml up -d

# Stop the manager
docker compose -f infra\sandbox\windows\docker-compose.yml down

# Live manager logs
docker logs -f devpilot-sandbox-manager

# List running sandbox containers
docker ps --filter "name=sandbox-"

# Stop and remove all sandbox containers
docker ps -q --filter "name=sandbox-" | ForEach-Object { docker stop $_ }
docker ps -aq --filter "name=sandbox-" | ForEach-Object { docker rm $_ }
```

## Start manager automatically on Windows startup

```powershell
# Register a scheduled task that starts the manager at login
$action  = New-ScheduledTaskAction -Execute "docker" -Argument "compose -f `"$PWD\infra\sandbox\windows\docker-compose.yml`" up -d"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "DevPilot Sandbox Manager" -Action $action -Trigger $trigger -RunLevel Highest
```

## Troubleshooting

### "docker: error during connect" / manager won't start

- Make sure Docker Desktop is running (check the system tray icon)
- Switch to Linux containers mode in Docker Desktop

### Desktop image build fails

```powershell
# Check what went wrong — run with verbose output (use host Docker socket, not the Win named pipe)
docker run --rm `
  -v "/var/run/docker.sock:/var/run/docker.sock" `
  -v "${PWD}\infra\sandbox:/workspace" `
  -w /workspace `
  -e BUILD_ONLY=1 `
  ubuntu:24.04 `
  bash -c "apt-get update && apt-get install -y docker.io curl wget git && bash setup.sh"
```

### Named pipe error on older Docker Desktop

Some older versions require the legacy pipe name. Edit `docker-compose.yml` and change:
```yaml
source: \\.\pipe\docker_engine
# to:
source: \\.\pipe\docker_engine_linux
```

### Sandbox containers don't appear

```powershell
# Check manager logs for errors
docker logs devpilot-sandbox-manager

# Verify the desktop image exists
docker images devpilot-desktop
```

## Files in this folder

| File | Purpose |
|------|---------|
| `setup.ps1` | One-click Windows setup script |
| `docker-compose.yml` | Runs the manager as a Docker container |
| `Dockerfile.manager` | Manager container image (Python + Flask + docker SDK) |
| `manager.py` | Standalone manager (same logic as embedded in `setup.sh`) |
| `.env` | Generated API key (gitignored) |
