#!/usr/bin/env python3
"""
DevPilot Sandbox Manager
Supports two backends selected by BACKEND env var:
  BACKEND=docker  (default) — Docker SDK, current behaviour
  BACKEND=k8s               — Kubernetes Python client
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
import uuid
import secrets
import threading
import time
import os
import json

app = Flask(__name__)
CORS(app)

SANDBOX_MANAGER_VERSION = "3.0.0"

BACKEND          = os.environ.get("BACKEND", "docker").lower()  # "docker" | "k8s"
MANAGER_API_KEY  = os.environ.get("MANAGER_API_KEY", "")
HOST_IP          = os.environ.get("HOST_IP", "localhost")
# When the frontend is served over HTTPS, direct HTTP sandbox URLs cause mixed-content
# errors in the browser.  Set HTTPS_PROXY_BASE to the public HTTPS origin
# (e.g. https://flexagent.online) and the manager will return proxy URLs that go
# through nginx's /sandbox-vnc/<port>/ and /sandbox-bridge/<port>/ locations.
HTTPS_PROXY_BASE = os.environ.get("HTTPS_PROXY_BASE", "").rstrip("/")


def _build_sandbox_urls(vnc_port: int, bridge_port: int) -> tuple[str, str]:
    """Return (vnc_url, bridge_url) — HTTPS proxy variants when HTTPS_PROXY_BASE is set."""
    if HTTPS_PROXY_BASE:
        vnc_url    = f"{HTTPS_PROXY_BASE}/sandbox-vnc/{vnc_port}/vnc.html"
        bridge_url = f"{HTTPS_PROXY_BASE}/sandbox-bridge/{bridge_port}"
    else:
        vnc_url    = f"http://{HOST_IP}:{vnc_port}/vnc.html"
        bridge_url = f"http://{HOST_IP}:{bridge_port}"
    return vnc_url, bridge_url

# In-memory cache: sandbox_id -> {created_at, port, bridge_port, sandbox_token, vnc_password}
# K8s is the source of truth for running state; this cache holds secrets + timestamps.
sandboxes = {}
lock = threading.Lock()

# ── Backend init ──────────────────────────────────────────────────────────────

if BACKEND == "k8s":
    from kubernetes import client as k8s_client, config as k8s_config
    import k8s_utils
    try:
        k8s_config.load_incluster_config()        # running inside a K8s pod
        print("[K8s] Loaded in-cluster config")
    except k8s_config.ConfigException:
        k8s_config.load_kube_config()             # running outside (local dev)
        print("[K8s] Loaded kube config (local dev)")
    core_v1 = k8s_client.CoreV1Api()
    print(f"[K8s] Backend ready — namespace: {k8s_utils.NAMESPACE}")
else:
    import docker as docker_sdk
    docker_client = docker_sdk.from_env()
    PORT_START = 6100
    PORT_END   = 6200
    used_ports: set = set()
    print("[Docker] Backend ready")

# ── Auth ──────────────────────────────────────────────────────────────────────

def require_api_key():
    if MANAGER_API_KEY:
        if request.headers.get("X-Api-Key", "") != MANAGER_API_KEY:
            return jsonify({"error": "Unauthorized"}), 401
    return None

# ── Docker port helpers ────────────────────────────────────────────────────────

def _docker_get_free_port():
    with lock:
        for port in range(PORT_START, PORT_END):
            if port not in used_ports:
                used_ports.add(port)
                return port
    return None

def _docker_release_port(port):
    with lock:
        used_ports.discard(port)

# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "version": SANDBOX_MANAGER_VERSION,
        "backend": BACKEND,
        "active_sandboxes": len(sandboxes),
    })


@app.route("/sandboxes", methods=["GET"])
def list_sandboxes():
    err = require_api_key()
    if err:
        return err

    if BACKEND == "k8s":
        return _k8s_list_sandboxes()
    return _docker_list_sandboxes()


@app.route("/sandboxes", methods=["POST"])
def create_sandbox():
    err = require_api_key()
    if err:
        return err

    print("=" * 50)
    print(f"CREATE SANDBOX REQUEST (Manager v{SANDBOX_MANAGER_VERSION}, backend={BACKEND})")
    print(f"Request JSON: {request.json}")
    print("=" * 50)

    if BACKEND == "k8s":
        return _k8s_create_sandbox()
    return _docker_create_sandbox()


@app.route("/sandboxes/<sandbox_id>", methods=["GET"])
def get_sandbox(sandbox_id):
    err = require_api_key()
    if err:
        return err

    if BACKEND == "k8s":
        return _k8s_get_sandbox(sandbox_id)
    return _docker_get_sandbox(sandbox_id)


@app.route("/sandboxes/<sandbox_id>", methods=["DELETE"])
def delete_sandbox(sandbox_id):
    err = require_api_key()
    if err:
        return err

    if BACKEND == "k8s":
        return _k8s_delete_sandbox(sandbox_id)
    return _docker_delete_sandbox(sandbox_id)


@app.route("/sandboxes/<sandbox_id>/stop", methods=["POST"])
def stop_sandbox(sandbox_id):
    err = require_api_key()
    if err:
        return err

    if BACKEND == "k8s":
        return _k8s_stop_sandbox(sandbox_id)
    return _docker_stop_sandbox(sandbox_id)

# ── Shared environment builder ────────────────────────────────────────────────

def _build_environment(data: dict, sandbox_id: str, sandbox_token: str, vnc_password: str) -> dict:
    environment = {
        "SANDBOX_ID":  sandbox_id,
        "RESOLUTION":  data.get("resolution", "1920x1080x24"),
        "SANDBOX_TOKEN": sandbox_token,
        "VNC_PASSWORD":  vnc_password,
    }

    repo_url     = data.get("repo_url", "")
    github_token = data.get("github_token", "")
    if repo_url and github_token and "github.com" in repo_url:
        repo_url = repo_url.replace("https://github.com/", f"https://{github_token}@github.com/")

    if repo_url:                          environment["REPO_URL"]         = repo_url
    if data.get("repo_name"):             environment["REPO_NAME"]        = data["repo_name"]
    if data.get("repo_branch"):           environment["REPO_BRANCH"]      = data["repo_branch"]
    if data.get("repo_archive_url"):      environment["REPO_ARCHIVE_URL"] = data["repo_archive_url"]

    if data.get("ai_config"):
        ai       = data["ai_config"]
        provider = ai.get("provider", "openai")
        model    = ai.get("model", "gpt-4o")
        api_key  = ai.get("api_key", "")
        base_url = ai.get("base_url", "")

        environment["DEVPILOT_MODEL"]    = model
        environment["DEVPILOT_PROVIDER"] = provider

        if api_key:
            if provider == "openai":     environment["OPENAI_API_KEY"]    = api_key
            elif provider == "anthropic": environment["ANTHROPIC_API_KEY"] = api_key
            elif provider == "custom":
                environment["OPENAI_API_KEY"] = api_key
                if base_url: environment["OPENAI_API_BASE"] = base_url

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
                    "always_allow_tool_actions": True,
                },
                "features": {"edit_prediction_provider": "zed"},
                "terminal": {"env": {"LIBGL_ALWAYS_SOFTWARE": "1"}},
                "worktree": {"trust_by_default": True},
                "language_models": {
                    "openai": {
                        "api_url": "http://localhost:8091/v1",
                        "available_models": [
                            {"name": model, "display_name": model, "max_tokens": 128000}
                        ],
                    }
                } if provider != "ollama" else {
                    "ollama": {"api_url": ai.get("base_url", "http://localhost:11434")}
                },
            }
            environment["ZED_SETTINGS_JSON"] = json.dumps(settings, indent=2)

    elif data.get("zed_settings"):
        environment["ZED_SETTINGS_JSON"] = json.dumps(data["zed_settings"], indent=2)

    safe_env = {k: ("***" if "KEY" in k or "TOKEN" in k else v) for k, v in environment.items()}
    print(f"Environment (redacted): {safe_env}")
    return environment

# ── Docker backend ────────────────────────────────────────────────────────────

def _docker_create_sandbox():
    data         = request.json or {}
    sandbox_id   = str(uuid.uuid4())[:8]
    sandbox_token = secrets.token_urlsafe(32)
    vnc_password  = secrets.token_urlsafe(8)[:8]
    port         = _docker_get_free_port()

    if not port:
        return jsonify({"error": "No ports available"}), 503

    bridge_port = port + 1000
    environment = _build_environment(data, sandbox_id, sandbox_token, vnc_password)

    try:
        container = docker_client.containers.run(
            "devpilot-desktop",
            name=f"sandbox-{sandbox_id}",
            detach=True,
            remove=False,
            ports={"6080/tcp": port, "8091/tcp": bridge_port},
            shm_size="512m",
            environment=environment,
        )

        with lock:
            sandboxes[sandbox_id] = {
                "container_id": container.id,
                "port": port,
                "bridge_port": bridge_port,
                "created_at": time.time(),
                "sandbox_token": sandbox_token,
                "vnc_password": vnc_password,
            }

        vnc_url, bridge_url = _build_sandbox_urls(port, bridge_port)
        return jsonify({
            "id": sandbox_id,
            "port": port,
            "bridge_port": bridge_port,
            "url":        vnc_url,
            "bridge_url": bridge_url,
            "status": "starting",
            "sandbox_token": sandbox_token,
            "vnc_password":  vnc_password,
        }), 201

    except Exception as e:
        _docker_release_port(port)
        return jsonify({"error": str(e)}), 500


def _docker_list_sandboxes():
    result = []
    for sid, info in sandboxes.items():
        try:
            container = docker_client.containers.get(info["container_id"])
            result.append({
                "id": sid,
                "port": info["port"],
                "bridge_port": info.get("bridge_port", 0),
                "status": container.status,
                "created_at": info["created_at"],
            })
        except Exception:
            pass
    return jsonify({"sandboxes": result})


def _docker_get_sandbox(sandbox_id):
    if sandbox_id not in sandboxes:
        return jsonify({"error": "Sandbox not found"}), 404
    info = sandboxes[sandbox_id]
    try:
        container = docker_client.containers.get(info["container_id"])
        return jsonify({"id": sandbox_id, "port": info["port"], "bridge_port": info.get("bridge_port", 0), "status": container.status})
    except Exception:
        return jsonify({"error": "Container not found"}), 404


def _docker_delete_sandbox(sandbox_id):
    if sandbox_id not in sandboxes:
        return jsonify({"error": "Sandbox not found"}), 404
    info = sandboxes.pop(sandbox_id)
    try:
        container = docker_client.containers.get(info["container_id"])
        container.stop(timeout=5)
        container.remove()
    except Exception:
        pass
    _docker_release_port(info["port"])
    return jsonify({"status": "deleted"})


def _docker_stop_sandbox(sandbox_id):
    if sandbox_id not in sandboxes:
        return jsonify({"error": "Sandbox not found"}), 404
    info = sandboxes[sandbox_id]
    try:
        container = docker_client.containers.get(info["container_id"])
        container.stop(timeout=5)
        return jsonify({"status": "stopped"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── K8s backend ───────────────────────────────────────────────────────────────

def _k8s_create_sandbox():
    data          = request.json or {}
    sandbox_id    = str(uuid.uuid4())[:8]
    sandbox_token = secrets.token_urlsafe(32)
    vnc_password  = secrets.token_urlsafe(8)[:8]
    environment   = _build_environment(data, sandbox_id, sandbox_token, vnc_password)

    vnc_port, bridge_port = k8s_utils.allocate_nodeport_pair(core_v1)
    if not vnc_port:
        return jsonify({"error": "No NodePorts available"}), 503

    try:
        pod_manifest = k8s_utils.build_pod_manifest(sandbox_id, environment)
        core_v1.create_namespaced_pod(namespace=k8s_utils.NAMESPACE, body=pod_manifest)

        svc_manifest = k8s_utils.build_service_manifest(sandbox_id, vnc_port, bridge_port)
        core_v1.create_namespaced_service(namespace=k8s_utils.NAMESPACE, body=svc_manifest)

        with lock:
            sandboxes[sandbox_id] = {
                "port": vnc_port,
                "bridge_port": bridge_port,
                "created_at": time.time(),
                "sandbox_token": sandbox_token,
                "vnc_password": vnc_password,
            }

        vnc_url, bridge_url = _build_sandbox_urls(vnc_port, bridge_port)
        return jsonify({
            "id": sandbox_id,
            "port": vnc_port,
            "bridge_port": bridge_port,
            "url":        vnc_url,
            "bridge_url": bridge_url,
            "status": "starting",
            "sandbox_token": sandbox_token,
            "vnc_password":  vnc_password,
        }), 201

    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _k8s_list_sandboxes():
    try:
        pods = core_v1.list_namespaced_pod(
            namespace=k8s_utils.NAMESPACE,
            label_selector="app=devpilot-sandbox",
        )
        result = []
        for pod in pods.items:
            sid   = pod.metadata.labels.get("sandbox-id")
            cache = sandboxes.get(sid, {})
            try:
                svc = core_v1.read_namespaced_service(
                    name=f"sandbox-{sid}", namespace=k8s_utils.NAMESPACE
                )
                vnc_port    = next((p.node_port for p in svc.spec.ports if p.name == "novnc"), 0)
                bridge_port = next((p.node_port for p in svc.spec.ports if p.name == "bridge"), 0)
            except Exception:
                vnc_port = bridge_port = 0

            result.append({
                "id": sid,
                "port": vnc_port,
                "bridge_port": bridge_port,
                "status": pod.status.phase or "Unknown",
                "created_at": cache.get("created_at", 0),
            })
        return jsonify({"sandboxes": result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _k8s_get_sandbox(sandbox_id):
    try:
        pod = core_v1.read_namespaced_pod(
            name=f"sandbox-{sandbox_id}", namespace=k8s_utils.NAMESPACE
        )
        cache = sandboxes.get(sandbox_id, {})
        return jsonify({
            "id": sandbox_id,
            "port": cache.get("port", 0),
            "bridge_port": cache.get("bridge_port", 0),
            "status": pod.status.phase or "Unknown",
        })
    except k8s_client.exceptions.ApiException as e:
        if e.status == 404:
            return jsonify({"error": "Sandbox not found"}), 404
        return jsonify({"error": str(e)}), 500


def _k8s_delete_sandbox(sandbox_id):
    errors = []
    for delete_fn, name in [
        (core_v1.delete_namespaced_pod, f"sandbox-{sandbox_id}"),
        (core_v1.delete_namespaced_service, f"sandbox-{sandbox_id}"),
    ]:
        try:
            delete_fn(name=name, namespace=k8s_utils.NAMESPACE)
        except k8s_client.exceptions.ApiException as e:
            if e.status != 404:
                errors.append(str(e))

    sandboxes.pop(sandbox_id, None)
    if errors:
        return jsonify({"error": "; ".join(errors)}), 500
    return jsonify({"status": "deleted"})


def _k8s_stop_sandbox(sandbox_id):
    # In K8s, "stop" = delete the Pod but keep the Service (preserve port allocation)
    try:
        core_v1.delete_namespaced_pod(
            name=f"sandbox-{sandbox_id}", namespace=k8s_utils.NAMESPACE
        )
        return jsonify({"status": "stopped"})
    except k8s_client.exceptions.ApiException as e:
        if e.status == 404:
            return jsonify({"error": "Sandbox not found"}), 404
        return jsonify({"error": str(e)}), 500

# ── Cleanup thread (Docker mode only — K8s uses CronJob) ─────────────────────

def _cleanup_old_sandboxes_docker():
    while True:
        time.sleep(300)
        now = time.time()
        to_delete = [sid for sid, info in list(sandboxes.items()) if now - info["created_at"] > 7200]
        for sid in to_delete:
            try:
                info = sandboxes.pop(sid, {})
                container = docker_client.containers.get(info["container_id"])
                container.stop(timeout=5)
                container.remove()
                _docker_release_port(info["port"])
                print(f"[cleanup] Removed orphan sandbox {sid}")
            except Exception:
                pass

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if BACKEND == "docker":
        threading.Thread(target=_cleanup_old_sandboxes_docker, daemon=True).start()

    print(f"DevPilot Sandbox Manager v{SANDBOX_MANAGER_VERSION} starting (BACKEND={BACKEND})...")
    app.run(host="0.0.0.0", port=8090)
