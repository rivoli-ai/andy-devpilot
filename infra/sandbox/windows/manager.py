#!/usr/bin/env python3
"""
DevPilot Sandbox Manager
Simple API to create/destroy isolated desktop containers
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
import docker
import uuid
import secrets
import threading
import time
import os

app = Flask(__name__)
CORS(app)

SANDBOX_MANAGER_VERSION = "2.3.0"

client = docker.from_env()

# API key protecting the manager — set via MANAGER_API_KEY env var
MANAGER_API_KEY = os.environ.get('MANAGER_API_KEY', '')

# Track active sandboxes: {sandbox_id: {container_id, port, bridge_port, created_at, sandbox_token, vnc_password}}
sandboxes = {}
PORT_START = 6100
PORT_END = 6200
used_ports = set()
lock = threading.Lock()

def require_api_key():
    """Return a 401 response if the request does not include a valid X-Api-Key header."""
    if MANAGER_API_KEY:
        provided = request.headers.get('X-Api-Key', '')
        if provided != MANAGER_API_KEY:
            return jsonify({'error': 'Unauthorized'}), 401
    return None

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
    return jsonify({
        "status": "ok",
        "version": SANDBOX_MANAGER_VERSION,
        "active_sandboxes": len(sandboxes)
    })

@app.route('/sandboxes', methods=['GET'])
def list_sandboxes():
    """List all active sandboxes"""
    err = require_api_key()
    if err:
        return err
    result = []
    for sid, info in sandboxes.items():
        try:
            container = client.containers.get(info['container_id'])
            result.append({
                "id": sid,
                "port": info['port'],
                "bridge_port": info.get('bridge_port', 0),
                "status": container.status,
                "created_at": info['created_at']
            })
        except:
            pass
    return jsonify({"sandboxes": result})

@app.route('/sandboxes', methods=['POST'])
def create_sandbox():
    """Create a new isolated sandbox with optional repo and AI config"""
    err = require_api_key()
    if err:
        return err

    import json

    print("=" * 50)
    print(f"CREATE SANDBOX REQUEST (Manager v{SANDBOX_MANAGER_VERSION})")
    print("=" * 50)
    print(f"Request JSON: {request.json}")
    print("=" * 50)

    sandbox_id = str(uuid.uuid4())[:8]
    port = get_free_port()
    sandbox_token = secrets.token_urlsafe(32)
    vnc_password = secrets.token_urlsafe(8)[:8]

    if not port:
        return jsonify({"error": "No ports available"}), 503

    try:
        data = request.json or {}

        environment = {
            "SANDBOX_ID": sandbox_id,
            "RESOLUTION": data.get("resolution", "1920x1080x24"),
            "SANDBOX_TOKEN": sandbox_token,
            "VNC_PASSWORD": vnc_password,
        }

        repo_url = data.get("repo_url", "")
        github_token = data.get("github_token", "")

        if repo_url and github_token and "github.com" in repo_url:
            repo_url = repo_url.replace("https://github.com/", f"https://{github_token}@github.com/")

        if repo_url:
            environment["REPO_URL"] = repo_url
        if data.get("repo_name"):
            environment["REPO_NAME"] = data["repo_name"]
        if data.get("repo_branch"):
            environment["REPO_BRANCH"] = data["repo_branch"]
        if data.get("repo_archive_url"):
            environment["REPO_ARCHIVE_URL"] = data["repo_archive_url"]

        if data.get("ai_config"):
            ai = data["ai_config"]
            provider = ai.get("provider", "openai")
            model = ai.get("model", "gpt-4o")
            api_key = ai.get("api_key", "")
            base_url = ai.get("base_url", "")

            environment["DEVPILOT_MODEL"] = model
            environment["DEVPILOT_PROVIDER"] = provider

            if api_key:
                if provider == "openai":
                    environment["OPENAI_API_KEY"] = api_key
                elif provider == "anthropic":
                    environment["ANTHROPIC_API_KEY"] = api_key
                elif provider == "custom":
                    environment["OPENAI_API_KEY"] = api_key
                    if base_url:
                        environment["OPENAI_API_BASE"] = base_url

            if data.get("zed_settings"):
                environment["ZED_SETTINGS_JSON"] = json.dumps(data["zed_settings"], indent=2)
            else:
                zed_provider = "openai" if provider == "custom" else provider
                settings = {
                    "theme": "One Dark",
                    "ui_font_size": 14,
                    "buffer_font_size": 14,
                    "agent": {
                        "enabled": True,
                        "default_model": {"provider": zed_provider, "model": model},
                        "always_allow_tool_actions": True
                    },
                    "features": {"edit_prediction_provider": "zed"},
                    "terminal": {"env": {"LIBGL_ALWAYS_SOFTWARE": "1"}},
                    "worktree": {"trust_by_default": True}
                }

                if provider == "ollama":
                    settings["language_models"] = {
                        "ollama": {"api_url": ai.get("base_url", "http://localhost:11434")}
                    }
                else:
                    settings["language_models"] = {
                        "openai": {
                            "api_url": "http://localhost:8091/v1",
                            "available_models": [
                                {"name": model, "display_name": model, "max_tokens": 128000}
                            ]
                        }
                    }

                environment["ZED_SETTINGS_JSON"] = json.dumps(settings, indent=2)
        elif data.get("zed_settings"):
            environment["ZED_SETTINGS_JSON"] = json.dumps(data["zed_settings"], indent=2)

        safe_env = {k: ('***' if 'KEY' in k or 'TOKEN' in k else v) for k, v in environment.items()}
        print(f"Environment variables: {safe_env}")

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
            "created_at": time.time(),
            "sandbox_token": sandbox_token,
            "vnc_password": vnc_password,
        }

        host_ip = os.environ.get('HOST_IP', 'localhost')
        return jsonify({
            "id": sandbox_id,
            "port": port,
            "bridge_port": bridge_port,
            "url": f"http://{host_ip}:{port}/vnc.html",
            "bridge_url": f"http://{host_ip}:{bridge_port}",
            "status": "starting",
            "sandbox_token": sandbox_token,
            "vnc_password": vnc_password,
        }), 201

    except Exception as e:
        release_port(port)
        return jsonify({"error": str(e)}), 500

@app.route('/sandboxes/<sandbox_id>', methods=['GET'])
def get_sandbox(sandbox_id):
    """Get sandbox status"""
    err = require_api_key()
    if err:
        return err
    if sandbox_id not in sandboxes:
        return jsonify({"error": "Sandbox not found"}), 404

    info = sandboxes[sandbox_id]
    try:
        container = client.containers.get(info['container_id'])
        return jsonify({
            "id": sandbox_id,
            "port": info['port'],
            "bridge_port": info.get('bridge_port', 0),
            "status": container.status
        })
    except:
        return jsonify({"error": "Container not found"}), 404

@app.route('/sandboxes/<sandbox_id>', methods=['DELETE'])
def delete_sandbox(sandbox_id):
    """Stop and remove a sandbox"""
    err = require_api_key()
    if err:
        return err
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
    err = require_api_key()
    if err:
        return err
    if sandbox_id not in sandboxes:
        return jsonify({"error": "Sandbox not found"}), 404

    info = sandboxes[sandbox_id]
    try:
        container = client.containers.get(info['container_id'])
        container.stop(timeout=5)
        return jsonify({"status": "stopped"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def cleanup_old_sandboxes():
    while True:
        time.sleep(300)
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
    threading.Thread(target=cleanup_old_sandboxes, daemon=True).start()
    print(f"DevPilot Sandbox Manager v{SANDBOX_MANAGER_VERSION} starting on port 8090...")
    app.run(host='0.0.0.0', port=8090)
