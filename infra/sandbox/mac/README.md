# DevPilot Sandbox — macOS Setup

Run the sandbox manager locally on **macOS** for development.  
No systemd — the manager runs as a background process.

## Prerequisites

- macOS 12+ (Monterey or later)
- **Docker Desktop for Mac** installed and running
  - Download: https://www.docker.com/products/docker-desktop
- Bash 4+ (macOS ships with Bash 3 — install via Homebrew if needed: `brew install bash`)
- Do **not** run with `sudo`

## Quick Start

```bash
# From the repo root
bash infra/sandbox/mac/setup.sh
```

The manager installs to `~/.devpilot-sandbox/` and starts in the background.

## What it does

1. Checks that Docker Desktop is running
2. Creates `~/.devpilot-sandbox/`
3. Uses `MANAGER_API_KEY` from environment if set, otherwise generates one and saves it to `~/.devpilot-sandbox/.env`
4. Copies custom certificates from `infra/sandbox/certs/`
5. Builds the `devpilot-desktop` Docker image (~10-20 min first time)
6. Starts the manager as a **background process** (PID saved to `~/.devpilot-sandbox/manager.pid`)

## After setup

### Retrieve the API key

```bash
cat ~/.devpilot-sandbox/.env
# MANAGER_API_KEY=<your_key>
```

### Configure the backend

In `backend/src/API/appsettings.Development.json`:

```json
"VPS": {
  "GatewayUrl": "http://localhost:8090",
  "ManagerApiKey": "<MANAGER_API_KEY>",
  "PublicIp": "localhost",
  "Enabled": true
}
```

## Manager management

```bash
cd ~/.devpilot-sandbox

# Status
./run.sh status

# Live logs
./run.sh logs

# Stop manager
./run.sh stop

# Start manager
./run.sh start

# Rebuild desktop image
./run.sh rebuild
```

Or manage manually:

```bash
# Check if running
ps aux | grep manager.py

# View logs
tail -f ~/.devpilot-sandbox/manager.log

# Kill manager
kill $(cat ~/.devpilot-sandbox/manager.pid)
```

## Re-deploy after code changes

```bash
# Pull latest and re-run setup
git pull
bash infra/sandbox/mac/setup.sh
```

## Corporate proxy / Zscaler certificates

Place your `.crt` files in `infra/sandbox/certs/` **before** running setup.  
See `infra/sandbox/certs/README.md` for how to export your corporate root CA.

## Troubleshooting

### Manager not starting

```bash
# Check Docker Desktop is running
docker info

# Check port 8090
lsof -i :8090

# Run manager manually to see errors
cd ~/.devpilot-sandbox
source .env
./venv/bin/python manager.py
```

### Desktop image build fails

```bash
# Rebuild with full output
bash infra/sandbox/mac/setup.sh

# Or rebuild manually
cd ~/.devpilot-sandbox
docker build -t devpilot-desktop ./desktop
```

### Container cleanup

```bash
# List running sandbox containers
docker ps --filter "name=sandbox-"

# Stop all sandbox containers
docker ps -q --filter "name=sandbox-" | xargs -r docker stop
docker ps -aq --filter "name=sandbox-" | xargs -r docker rm
```

### Full reset

```bash
# Stop manager
kill $(cat ~/.devpilot-sandbox/manager.pid) 2>/dev/null

# Remove containers and image
docker rm -f $(docker ps -aq --filter "name=sandbox-") 2>/dev/null
docker rmi devpilot-desktop 2>/dev/null

# Clean install
rm -rf ~/.devpilot-sandbox
bash infra/sandbox/mac/setup.sh
```
