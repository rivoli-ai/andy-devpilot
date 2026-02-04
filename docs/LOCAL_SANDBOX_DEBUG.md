# Debugging the Sandbox Locally (Docker on your machine)

Use this guide when running the DevPilot sandbox on your Mac (or Linux) instead of a remote VPS, so you can debug the manager and containers.

## 1. One-time setup

### Run the sandbox installer

From the repo root:

```bash
cd sandbox
sudo bash setup.sh
```

This will:

- Install Docker if needed
- Build the `devpilot-desktop` image
- Create the sandbox manager (Python Flask) and a venv
- On **macOS**: start the manager in the background and create `run.sh`
- On **Linux**: install a systemd service

Installation directory: **`/opt/devpilot-sandbox`** (manager, `run.sh`, `manager.py`, `desktop/`).

### Point app to local sandbox

- **Frontend**  
  `frontend/src/app/core/config/vps.config.ts` should already use `ip: 'localhost'` and `sandboxApiPort: 8090`. If you use a different host/port, change them there.

- **Backend**  
  In `src/API/appsettings.Development.json` add (or merge) a `VPS` section so the API talks to your local manager:

```json
{
  "VPS": {
    "GatewayUrl": "http://localhost:8090",
    "SessionTimeoutMinutes": 60,
    "Enabled": true
  }
}
```

Restart the API after changing this.

## 2. Run and debug the sandbox manager

### Start / stop (background)

```bash
cd /opt/devpilot-sandbox
./run.sh start   # start manager on port 8090
./run.sh stop    # stop manager
./run.sh status  # is it running?
./run.sh logs    # tail manager.log (macOS) or journalctl (Linux)
```

### Run manager in foreground (for debugging)

Stop the background process first, then run the manager directly so you see all logs and errors:

```bash
cd /opt/devpilot-sandbox
./run.sh stop
# Run in foreground (Ctrl+C to stop)
./venv/bin/python manager.py
```

You should see:

- `DevPilot Sandbox Manager starting on port 8090...`
- Incoming requests and any Python tracebacks when you create/list/delete sandboxes.

### Quick health check

```bash
curl http://localhost:8090/health
# Expected: {"status":"ok"}
```

## 3. Debug individual sandbox containers

After creating a sandbox from the UI (or via `POST /sandboxes`), you get a container named `sandbox-<id>`.

### List containers

```bash
docker ps --filter "name=sandbox-"
```

### View container logs

```bash
docker logs sandbox-<id>
# Follow:
docker logs -f sandbox-<id>
```

### Shell into the container

```bash
docker exec -it sandbox-<id> bash
```

Then you can:

- Inspect env: `env | grep -E 'REPO_|ZED_|OPENAI|DEVPILOT'`
- Check repo: `ls -la /home/sandbox/projects/repo` and `git -C /home/sandbox/projects/repo status`
- Check Zed config: `cat /home/sandbox/.config/zed/settings.json`
- Check debug/error logs: `cat /tmp/sandbox-debug.log`, `cat /tmp/zed-errors.log`
- See processes: `ps aux | grep -E 'zed|Xvfb|novnc'`

### Run Zed manually (to see startup errors)

```bash
docker exec -it sandbox-<id> bash -c '
  source /tmp/dbus-env.sh
  export DISPLAY=:0 LIBGL_ALWAYS_SOFTWARE=1 HOME=/home/sandbox
  /home/sandbox/.local/bin/zed --foreground /home/sandbox/projects 2>&1
'
```

### Bridge API (per-sandbox)

Each sandbox exposes a bridge on port `VNC_PORT + 1000` (e.g. 7100 for VNC 6100). From the host:

```bash
curl http://localhost:7100/health
curl http://localhost:7100/git/status
```

Use the actual bridge port returned in the create-sandbox response.

## 4. Rebuild desktop image after changes

If you change `sandbox/setup.sh` (e.g. the Dockerfile or `desktop/` assets):

```bash
cd /opt/devpilot-sandbox
./run.sh rebuild
# Or manually:
docker build -t devpilot-desktop ./desktop
```

Then create a new sandbox; existing containers keep the old image until recreated.

## 5. Clean up

```bash
cd /opt/devpilot-sandbox
./run.sh cleanup   # remove all sandbox-* containers
./run.sh stop      # stop manager
```

Optional full reset (containers + image + manager state):

```bash
cd /path/to/andy-devpilot/sandbox
sudo bash setup.sh
```

This tears down everything and runs a fresh install.

## 6. Typical issues

| Symptom | What to do |
|--------|------------|
| Manager not responding | `./run.sh status`; run `./venv/bin/python manager.py` in foreground and watch for errors. |
| Port 8090 in use | `lsof -i :8090` (or `netstat -tlnp \| grep 8090` on Linux); stop the process or change the port in `manager.py` and in app config. |
| Sandbox container exits immediately | `docker logs sandbox-<id>` and `docker logs -f sandbox-<id>` to see exit reason. |
| Zed not starting in container | Use “Run Zed manually” above; check `cat /tmp/zed-errors.log` and `/tmp/sandbox-debug.log`. |
| Frontend can’t open VNC | Ensure `vps.config.ts` uses `localhost` and the VNC port returned by the create-sandbox API (e.g. 6100). |
| API doesn’t create sandboxes | Confirm `appsettings.Development.json` has `VPS:GatewayUrl: "http://localhost:8090"` and `VPS:Enabled: true`, then restart the API. |

Using these steps you can run and debug the full sandbox stack (manager + Docker containers) on your local machine.
