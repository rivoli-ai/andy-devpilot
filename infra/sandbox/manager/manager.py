#!/usr/bin/env python3
"""
DevPilot Sandbox Manager
Supports two backends selected by BACKEND env var:
  BACKEND=docker  (default) — Docker SDK, current behaviour
  BACKEND=k8s               — Kubernetes Python client
"""

from flask import Flask, jsonify, request, Response
from flask_cors import CORS
from flask_sock import Sock
import uuid
import secrets
import threading
import time
import os
import json
import traceback
import requests as http_requests
import websocket as ws_client

app = Flask(__name__)
CORS(app)
sock = Sock(app)

SANDBOX_MANAGER_VERSION = "3.1.0"

BACKEND          = os.environ.get("BACKEND", "docker").lower()  # "docker" | "k8s"
MANAGER_API_KEY  = os.environ.get("MANAGER_API_KEY", "")
HOST_IP          = os.environ.get("HOST_IP", "localhost")
SANDBOX_IMAGE    = os.environ.get("SANDBOX_IMAGE", "devpilot-desktop:latest")
HTTPS_PROXY_BASE = os.environ.get("HTTPS_PROXY_BASE", "").rstrip("/")

SANDBOX_NETWORK  = "devpilot-sandbox-net"
MANAGER_PORT     = 8090

def _running_inside_docker() -> bool:
    if os.path.exists("/.dockerenv"):
        return True
    try:
        with open("/proc/1/cgroup") as f:
            return "docker" in f.read()
    except (FileNotFoundError, PermissionError):
        return False

MANAGER_IN_DOCKER = _running_inside_docker()

# Propagate host bind mounts into each devpilot-desktop container (npm / NuGet / pip).
# See infra/sandbox/README.md (Host package caches).
SANDBOX_PACKAGE_CACHE_MOUNTS = os.environ.get("SANDBOX_PACKAGE_CACHE_MOUNTS", "true").lower() in (
    "1",
    "true",
    "yes",
    "on",
)


def _build_sandbox_urls(sandbox_id: str, vnc_port: int = 0, bridge_port: int = 0) -> tuple[str, str]:
    """Return (vnc_url, bridge_url).

    Docker mode: routed through the manager reverse proxy on :8090.
    K8s mode: uses NodePort-based URLs (ports must be provided).
    """
    vnc_qs = "autoconnect=true&reconnect=true&reconnect_delay=3000&scale=true"
    if BACKEND == "k8s" and vnc_port:
        if HTTPS_PROXY_BASE:
            vnc_url    = f"{HTTPS_PROXY_BASE}/sandbox-vnc/{vnc_port}/vnc_lite.html?{vnc_qs}"
            bridge_url = f"{HTTPS_PROXY_BASE}/sandbox-bridge/{bridge_port}"
        else:
            vnc_url    = f"http://{HOST_IP}:{vnc_port}/vnc_lite.html?{vnc_qs}"
            bridge_url = f"http://{HOST_IP}:{bridge_port}"
    else:
        base = HTTPS_PROXY_BASE if HTTPS_PROXY_BASE else f"http://{HOST_IP}:{MANAGER_PORT}"
        ws_path = f"sandbox/{sandbox_id}/vnc/websockify"
        vnc_url    = f"{base}/sandbox/{sandbox_id}/vnc/vnc_lite.html?{vnc_qs}&path={ws_path}"
        bridge_url = f"{base}/sandbox/{sandbox_id}/bridge"
    return vnc_url, bridge_url


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
    import socket as _socket
    docker_client = docker_sdk.from_env()

    def _discover_host_bind_mount(destination: str) -> str | None:
        """Return the host path bind-mounted to *destination* on this container, if any."""
        try:
            hostname = _socket.gethostname()
            info = docker_client.api.inspect_container(hostname)
            for mount in info.get("Mounts", []):
                if mount.get("Destination") == destination and mount.get("Type") == "bind":
                    return mount.get("Source")
        except Exception:
            pass
        return None

    def _discover_host_certs_dir() -> str | None:
        """Find the host path that is bind-mounted to /certs on this container."""
        return _discover_host_bind_mount("/certs")

    HOST_CERTS_DIR = _discover_host_certs_dir()
    if HOST_CERTS_DIR:
        print(f"[Docker] Host certs directory: {HOST_CERTS_DIR}")
    else:
        print("[Docker] No host certs mount detected — sandbox containers won't get extra CAs")

    def _host_bind_source_for_sandbox_cache(container_mount: str, override_env: str) -> str | None:
        """Resolve the host path to bind into the sandbox for a shared tool cache.

        Precedence:
        1) *override_env* if set (absolute path on the Docker host).
        2) Inspect this container for a bind mount at *container_mount* (manager-in-Docker).
        3) If the manager runs on the host, use *container_mount* when that directory exists.
        """
        explicit = os.environ.get(override_env, "").strip()
        if explicit:
            return explicit
        discovered = _discover_host_bind_mount(container_mount)
        if discovered:
            return discovered
        if not MANAGER_IN_DOCKER and os.path.isdir(container_mount):
            return container_mount
        return None

    def _docker_mount_package_caches(volumes: dict) -> None:
        if not SANDBOX_PACKAGE_CACHE_MOUNTS:
            return
        for container_path, override_env in (
            ("/opt/npm-cache", "SANDBOX_NPM_CACHE_HOST"),
            ("/opt/nuget-cache", "SANDBOX_NUGET_CACHE_HOST"),
            ("/opt/pip-cache", "SANDBOX_PIP_CACHE_HOST"),
        ):
            src = _host_bind_source_for_sandbox_cache(container_path, override_env)
            if src:
                volumes[src] = {"bind": container_path, "mode": "rw"}
                print(f"[Docker] Sandbox package cache: {src} -> {container_path}")

    def _docker_env_for_package_cache_mounts(volumes: dict) -> dict:
        """Set tool cache env vars for any package-cache bind mounts (works with older desktop images)."""
        binds = {spec["bind"] for spec in volumes.values() if isinstance(spec, dict) and spec.get("bind")}
        env: dict[str, str] = {}
        if "/opt/npm-cache" in binds:
            env["NPM_CONFIG_CACHE"] = "/opt/npm-cache"
        if "/opt/nuget-cache" in binds:
            env["NUGET_PACKAGES"] = "/opt/nuget-cache/packages"
            env["NUGET_HTTP_CACHE_PATH"] = "/opt/nuget-cache/http-cache"
            env["NUGET_PLUGINS_CACHE_PATH"] = "/opt/nuget-cache/plugins-cache"
            env["NUGET_SCRATCH"] = "/opt/nuget-cache/scratch"
        if "/opt/pip-cache" in binds:
            env["PIP_CACHE_DIR"] = "/opt/pip-cache"
        return env

    def _ensure_sandbox_network():
        """Create the shared Docker bridge network if it doesn't exist, and attach this manager container."""
        try:
            net = docker_client.networks.get(SANDBOX_NETWORK)
        except docker_sdk.errors.NotFound:
            net = docker_client.networks.create(SANDBOX_NETWORK, driver="bridge")
            print(f"[Docker] Created network: {SANDBOX_NETWORK}")
        try:
            hostname = _socket.gethostname()
            net.connect(hostname)
            print(f"[Docker] Manager joined network: {SANDBOX_NETWORK}")
        except docker_sdk.errors.APIError:
            pass

    _ensure_sandbox_network()
    print("[Docker] Backend ready")

# ── Auth ──────────────────────────────────────────────────────────────────────

def require_api_key():
    if MANAGER_API_KEY:
        if request.headers.get("X-Api-Key", "") != MANAGER_API_KEY:
            return jsonify({"error": "Unauthorized"}), 401
    return None


def _sandbox_container_name(sandbox_id: str) -> str:
    return f"sandbox-{sandbox_id}"

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
                "agent_servers": {
                    "DevPilot": {
                        "command": "/opt/devpilot-venv/bin/python",
                        "args": ["/opt/devpilot/bridge/acp_agent.py"],
                    }
                },
                "features": {"edit_prediction_provider": "zed"},
                "terminal": {"dock": "bottom", "env": {"LIBGL_ALWAYS_SOFTWARE": "1"}},
                "worktree": {"trust_by_default": True},
                "telemetry": {"diagnostics": False, "metrics": False},
                "workspace": {"title_bar": {"show_onboarding_banner": False}},
                "show_call_status_icon": False,
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

    if data.get("artifact_feeds"):
        environment["ARTIFACT_FEEDS_JSON"] = json.dumps(data["artifact_feeds"])
    if data.get("azure_devops_pat"):
        environment["AZURE_DEVOPS_PAT"] = data["azure_devops_pat"]
    if data.get("agent_rules"):
        environment["AGENT_RULES"] = data["agent_rules"]

    if data.get("azure_identity_client_id"):
        environment["AZURE_CLIENT_ID"] = data["azure_identity_client_id"]
    if data.get("azure_identity_client_secret"):
        environment["AZURE_CLIENT_SECRET"] = data["azure_identity_client_secret"]
    if data.get("azure_identity_tenant_id"):
        environment["AZURE_TENANT_ID"] = data["azure_identity_tenant_id"]

    safe_env = {k: ("***" if "KEY" in k or "TOKEN" in k or "PAT" in k or "SECRET" in k else v) for k, v in environment.items()}
    print(f"Environment (redacted): {safe_env}")
    return environment

# ── Docker backend ────────────────────────────────────────────────────────────

def _docker_create_sandbox():
    data         = request.json or {}
    sandbox_id   = str(uuid.uuid4())[:8]
    sandbox_token = secrets.token_urlsafe(32)
    vnc_password  = secrets.token_urlsafe(8)[:8]
    environment  = _build_environment(data, sandbox_id, sandbox_token, vnc_password)
    cname        = _sandbox_container_name(sandbox_id)

    volumes = {}
    if HOST_CERTS_DIR:
        volumes[HOST_CERTS_DIR] = {"bind": "/usr/local/share/ca-certificates/custom", "mode": "ro"}
    _docker_mount_package_caches(volumes)
    environment = {**environment, **_docker_env_for_package_cache_mounts(volumes)}

    ports = None
    if not MANAGER_IN_DOCKER:
        ports = {"6080/tcp": None, "8091/tcp": None}

    try:
        container = docker_client.containers.run(
            SANDBOX_IMAGE,
            name=cname,
            detach=True,
            remove=False,
            network=SANDBOX_NETWORK,
            shm_size="512m",
            environment=environment,
            volumes=volumes or None,
            ports=ports,
        )

        with lock:
            sandboxes[sandbox_id] = {
                "container_id": container.id,
                "created_at": time.time(),
                "sandbox_token": sandbox_token,
                "vnc_password": vnc_password,
            }

        vnc_url, bridge_url = _build_sandbox_urls(sandbox_id)
        return jsonify({
            "id": sandbox_id,
            "url":        vnc_url,
            "bridge_url": bridge_url,
            "status": "starting",
            "sandbox_token": sandbox_token,
            "vnc_password":  vnc_password,
        }), 201

    except Exception as e:
        print(f"[Docker] create_sandbox failed: {e!r}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


def _docker_list_sandboxes():
    result = []
    for sid, info in sandboxes.items():
        try:
            container = docker_client.containers.get(info["container_id"])
            vnc_url, bridge_url = _build_sandbox_urls(sid)
            result.append({
                "id": sid,
                "url": vnc_url,
                "bridge_url": bridge_url,
                "status": container.status,
                "created_at": info["created_at"],
                "sandbox_token": info.get("sandbox_token", ""),
                "vnc_password": info.get("vnc_password", ""),
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
        vnc_url, bridge_url = _build_sandbox_urls(sandbox_id)
        return jsonify({
            "id": sandbox_id,
            "url": vnc_url,
            "bridge_url": bridge_url,
            "status": container.status,
            "sandbox_token": info.get("sandbox_token", ""),
            "vnc_password": info.get("vnc_password", ""),
        })
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

# ── Reverse proxy routes (Docker mode) ────────────────────────────────────────
# All sandbox traffic is proxied through the manager so only port 8090 is needed.

def _resolve_sandbox_target(sandbox_id: str, container_port: int = 8091) -> tuple[str, int] | None:
    """Return (host, port) reachable from the manager for the given sandbox.

    Inside Docker: use container name + internal port.
    On host: use localhost + Docker-published host port.
    """
    if sandbox_id not in sandboxes:
        return None
    if MANAGER_IN_DOCKER:
        return (_sandbox_container_name(sandbox_id), container_port)
    try:
        container = docker_client.containers.get(sandboxes[sandbox_id]["container_id"])
        container.reload()
        port_map = container.ports.get(f"{container_port}/tcp")
        if port_map:
            return ("127.0.0.1", int(port_map[0]["HostPort"]))
    except Exception:
        pass
    return None


@app.route("/sandbox/<sandbox_id>/bridge/", defaults={"subpath": ""}, methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
@app.route("/sandbox/<sandbox_id>/bridge/<path:subpath>", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
def proxy_bridge(sandbox_id, subpath):
    """HTTP reverse proxy to sandbox Bridge API (container port 8091)."""
    target = _resolve_sandbox_target(sandbox_id, 8091)
    if not target:
        return jsonify({"error": "Sandbox not found"}), 404

    host, port = target
    url = f"http://{host}:{port}/{subpath}"
    if request.query_string:
        url += f"?{request.query_string.decode()}"

    headers = {k: v for k, v in request.headers if k.lower() not in ("host", "content-length")}
    try:
        resp = http_requests.request(
            method=request.method,
            url=url,
            headers=headers,
            data=request.get_data(),
            stream=True,
            timeout=120,
        )
        excluded = {"content-encoding", "transfer-encoding", "content-length", "connection"}
        proxy_headers = [(k, v) for k, v in resp.raw.headers.items() if k.lower() not in excluded]
        return Response(resp.iter_content(chunk_size=4096), status=resp.status_code, headers=proxy_headers)
    except http_requests.exceptions.ConnectionError:
        return jsonify({"error": "Sandbox bridge not reachable (container may still be starting)"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.route("/sandbox/<sandbox_id>/vnc/", defaults={"subpath": ""})
@app.route("/sandbox/<sandbox_id>/vnc/<path:subpath>")
def proxy_vnc_http(sandbox_id, subpath):
    """HTTP reverse proxy for noVNC static assets (HTML, JS, CSS)."""
    target = _resolve_sandbox_target(sandbox_id, 6080)
    if not target:
        return jsonify({"error": "Sandbox not found"}), 404

    host, port = target
    url = f"http://{host}:{port}/{subpath}"
    if request.query_string:
        url += f"?{request.query_string.decode()}"

    headers = {k: v for k, v in request.headers if k.lower() not in ("host", "content-length")}
    try:
        resp = http_requests.get(url, headers=headers, stream=True, timeout=30)
        excluded = {"content-encoding", "transfer-encoding", "content-length", "connection"}
        proxy_headers = [(k, v) for k, v in resp.raw.headers.items() if k.lower() not in excluded]
        return Response(resp.iter_content(chunk_size=4096), status=resp.status_code, headers=proxy_headers)
    except http_requests.exceptions.ConnectionError:
        return jsonify({"error": "Sandbox VNC not reachable (container may still be starting)"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@sock.route("/sandbox/<sandbox_id>/vnc/websockify")
def proxy_vnc_websocket(ws, sandbox_id):
    """WebSocket reverse proxy for noVNC ↔ VNC (websockify inside the container)."""
    target = _resolve_sandbox_target(sandbox_id, 6080)
    if not target:
        ws.close(1008, "Sandbox not found")
        return

    host, port = target
    upstream_url = f"ws://{host}:{port}/websockify"
    try:
        upstream = ws_client.create_connection(upstream_url, timeout=10)
        # After connecting, remove the socket timeout so recv_data() blocks
        # indefinitely instead of killing the connection when VNC is idle.
        upstream.settimeout(None)
    except Exception:
        ws.close(1011, "Cannot connect to sandbox VNC")
        return

    alive = threading.Event()

    def keepalive():
        """Send WebSocket pings every 25s to keep the connection alive through proxies."""
        while not alive.wait(25):
            try:
                upstream.ping()
            except Exception:
                break

    def forward_upstream_to_client():
        try:
            while True:
                opcode, data = upstream.recv_data()
                if opcode == ws_client.ABNF.OPCODE_CLOSE:
                    break
                if opcode == ws_client.ABNF.OPCODE_BINARY:
                    ws.send(data)
                elif opcode == ws_client.ABNF.OPCODE_TEXT:
                    ws.send(data.decode("utf-8", errors="replace"))
        except Exception:
            pass
        finally:
            alive.set()
            try:
                ws.close()
            except Exception:
                pass

    reader = threading.Thread(target=forward_upstream_to_client, daemon=True)
    reader.start()
    pinger = threading.Thread(target=keepalive, daemon=True)
    pinger.start()

    try:
        while True:
            data = ws.receive()
            if data is None:
                break
            if isinstance(data, bytes):
                upstream.send_binary(data)
            else:
                upstream.send(data)
    except Exception:
        pass
    finally:
        alive.set()
        upstream.close()
        reader.join(timeout=2)


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

        vnc_url, bridge_url = _build_sandbox_urls(sandbox_id, vnc_port=vnc_port, bridge_port=bridge_port)
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

            vnc_url, bridge_url = _build_sandbox_urls(sid, vnc_port=vnc_port, bridge_port=bridge_port)
            result.append({
                "id": sid,
                "port": vnc_port,
                "bridge_port": bridge_port,
                "url": vnc_url,
                "bridge_url": bridge_url,
                "status": pod.status.phase or "Unknown",
                "created_at": cache.get("created_at", 0),
                "sandbox_token": cache.get("sandbox_token", ""),
                "vnc_password": cache.get("vnc_password", ""),
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
        vnc_port = cache.get("port", 0)
        bridge_port = cache.get("bridge_port", 0)
        vnc_url, bridge_url = _build_sandbox_urls(sandbox_id, vnc_port=vnc_port, bridge_port=bridge_port)
        return jsonify({
            "id": sandbox_id,
            "port": vnc_port,
            "bridge_port": bridge_port,
            "url": vnc_url,
            "bridge_url": bridge_url,
            "status": pod.status.phase or "Unknown",
            "sandbox_token": cache.get("sandbox_token", ""),
            "vnc_password": cache.get("vnc_password", ""),
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
                print(f"[cleanup] Removed orphan sandbox {sid}")
            except Exception:
                pass

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if BACKEND == "docker":
        threading.Thread(target=_cleanup_old_sandboxes_docker, daemon=True).start()

    bind_host = os.environ.get("MANAGER_BIND_HOST", "127.0.0.1")
    print(f"DevPilot Sandbox Manager v{SANDBOX_MANAGER_VERSION} starting (BACKEND={BACKEND})...")
    app.run(host=bind_host, port=8090)
