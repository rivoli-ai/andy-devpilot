#!/usr/bin/env python3
"""
DevPilot ACP Agent

A proper Agent Client Protocol agent that Zed spawns as a subprocess.
Communicates over stdin/stdout using JSON-RPC 2.0.

Register in Zed's settings.json::

    {
      "agent_servers": {
        "DevPilot": {
          "command": "/opt/devpilot-venv/bin/python",
          "args": ["/opt/devpilot/bridge/acp_agent.py"]
        }
      }
    }
"""

import asyncio
import json
import logging
import os
import sys
import time
import uuid
from typing import Any

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [ACP] %(levelname)s %(message)s",
    handlers=[logging.FileHandler("/tmp/devpilot-acp.log")],
)
logger = logging.getLogger(__name__)

# Ensure the bridge package is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bridge import tools
from bridge.agent_loop import run as run_agent_loop

# ── Configuration ─────────────────────────────────────────────────────────────

API_KEY = os.environ.get("OPENAI_API_KEY", "")
API_BASE = os.environ.get("OPENAI_API_BASE", "http://localhost:8091/v1")
MODEL = os.environ.get("DEVPILOT_MODEL", os.environ.get("LLM_MODEL", "gpt-4o"))
PROJECT_PATH = os.environ.get(
    "DEVPILOT_PROJECT_PATH", "/home/sandbox/projects"
)

CONVERSATIONS_FILE = "/tmp/devpilot-acp-conversations.json"

# ── JSON-RPC transport ────────────────────────────────────────────────────────


class JsonRpcTransport:
    """Minimal JSON-RPC 2.0 over stdin/stdout."""

    def __init__(self) -> None:
        self._reader: asyncio.StreamReader | None = None
        self._writer = sys.stdout

    async def start(self) -> None:
        loop = asyncio.get_event_loop()
        self._reader = asyncio.StreamReader()
        await loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(self._reader), sys.stdin
        )

    async def read_message(self) -> dict[str, Any] | None:
        assert self._reader is not None
        line = await self._reader.readline()
        if not line:
            return None
        try:
            msg = json.loads(line)
            logger.debug("← %s", line.decode().strip()[:300])
            return msg
        except json.JSONDecodeError as exc:
            logger.error("Bad JSON from client: %s", exc)
            return None

    def send(self, message: dict[str, Any]) -> None:
        raw = json.dumps(message, separators=(",", ":"))
        logger.debug("→ %s", raw[:300])
        print(raw, flush=True)

    def respond(self, request_id: int | str, result: dict[str, Any]) -> None:
        self.send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def error(self, request_id: int | str, code: int, message: str) -> None:
        self.send({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": message},
        })

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})


# ── Agent ─────────────────────────────────────────────────────────────────────


class DevPilotAgent:
    """ACP-compliant agent backed by the shared tool engine."""

    def __init__(self, transport: JsonRpcTransport) -> None:
        self.transport = transport
        self.sessions: dict[str, dict[str, Any]] = {}
        self._llm_client: Any = None

    def _get_client(self) -> Any:
        if self._llm_client is None:
            from openai import OpenAI

            self._llm_client = OpenAI(api_key=API_KEY or "not-needed", base_url=API_BASE)
        return self._llm_client

    # ── ACP handlers ──────────────────────────────────────────────────────

    async def handle_initialize(self, msg_id: int | str, params: dict) -> None:
        logger.info("initialize (protocol_version=%s)", params.get("protocolVersion"))
        self.transport.respond(msg_id, {
            "protocolVersion": params.get("protocolVersion", 1),
            "agentCapabilities": {
                "loadSession": False,
            },
            "agentInfo": {
                "name": "DevPilot",
                "version": "2.0.0",
            },
        })

    async def handle_new_session(self, msg_id: int | str, params: dict) -> None:
        session_id = str(uuid.uuid4())
        cwd = params.get("cwd", PROJECT_PATH)
        self.sessions[session_id] = {"cwd": cwd, "history": []}
        logger.info("new session %s (cwd=%s)", session_id, cwd)
        self.transport.respond(msg_id, {"sessionId": session_id})

    async def handle_prompt(self, msg_id: int | str, params: dict) -> None:
        session_id = params.get("sessionId", "")
        session = self.sessions.get(session_id)
        if session is None:
            self.transport.error(msg_id, -32602, f"Unknown session: {session_id}")
            return

        prompt_blocks = params.get("prompt", [])
        user_text = " ".join(
            block.get("text", "")
            for block in prompt_blocks
            if block.get("type") == "text"
        )
        if not user_text:
            self.transport.error(msg_id, -32602, "Empty prompt")
            return

        logger.info("prompt [%s]: %s", session_id, user_text[:120])
        project_path = session["cwd"]

        def on_tool_call(name: str, arguments: dict, result: str) -> None:
            tool_call_id = f"tc_{uuid.uuid4().hex[:8]}"
            self.transport.notify("session/update", {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": tool_call_id,
                    "title": f"{name}: {_tool_title(name, arguments)}",
                    "kind": _acp_kind(name),
                    "status": "completed",
                    "content": [{
                        "type": "content",
                        "content": {"type": "text", "text": result[:4000]},
                    }],
                },
            })

        loop = asyncio.get_event_loop()
        agent_result = await loop.run_in_executor(
            None,
            lambda: run_agent_loop(
                prompt=user_text,
                project_path=project_path,
                llm_client=self._get_client(),
                model=MODEL,
                on_tool_call=on_tool_call,
            ),
        )

        if agent_result.content:
            self.transport.notify("session/update", {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": agent_result.content},
                },
            })

        self._save_conversation(user_text, agent_result)
        self.transport.respond(msg_id, {"stopReason": "end_turn"})
        logger.info(
            "prompt complete [%s]: %d iterations, %d tool calls",
            session_id, agent_result.iterations, len(agent_result.tool_executions),
        )

    async def handle_cancel(self, params: dict) -> None:
        logger.info("cancel session %s (not yet implemented)", params.get("sessionId"))

    # ── Helpers ───────────────────────────────────────────────────────────

    def _save_conversation(self, user_msg: str, result: Any) -> None:
        """Persist the conversation so the bridge /all-conversations endpoint can serve it."""
        try:
            conversations: list[dict] = []
            if os.path.exists(CONVERSATIONS_FILE):
                with open(CONVERSATIONS_FILE) as f:
                    conversations = json.load(f).get("conversations", [])

            entry: dict[str, Any] = {
                "id": str(uuid.uuid4()),
                "timestamp": time.time(),
                "user_message": user_msg,
                "assistant_message": result.content,
                "model": MODEL,
                "source": "acp_agent",
                "had_tool_execution": len(result.tool_executions) > 0,
                "tool_calls": [
                    {"name": tc.name, "args": tc.arguments, "result": tc.result[:500]}
                    for tc in result.tool_executions
                ],
                "iterations": result.iterations,
            }
            conversations.append(entry)
            conversations = conversations[-50:]

            with open(CONVERSATIONS_FILE, "w") as f:
                json.dump({"conversations": conversations, "count": len(conversations)}, f)
        except Exception as exc:
            logger.error("Failed to save conversation: %s", exc)

    # ── Main loop ─────────────────────────────────────────────────────────

    async def run(self) -> None:
        await self.transport.start()
        logger.info("DevPilot ACP agent started (model=%s, project=%s)", MODEL, PROJECT_PATH)

        while True:
            msg = await self.transport.read_message()
            if msg is None:
                logger.info("stdin closed — shutting down")
                break

            method = msg.get("method")
            msg_id = msg.get("id")
            params = msg.get("params", {})

            try:
                if method == "initialize":
                    await self.handle_initialize(msg_id, params)
                elif method == "session/new":
                    await self.handle_new_session(msg_id, params)
                elif method == "session/prompt":
                    await self.handle_prompt(msg_id, params)
                elif method == "session/cancel":
                    await self.handle_cancel(params)
                elif method == "shutdown":
                    if msg_id is not None:
                        self.transport.respond(msg_id, {})
                    break
                else:
                    logger.warning("Unhandled method: %s", method)
                    if msg_id is not None:
                        self.transport.error(msg_id, -32601, f"Method not found: {method}")
            except Exception as exc:
                logger.exception("Error handling %s", method)
                if msg_id is not None:
                    self.transport.error(msg_id, -32000, str(exc))


# ── Utilities ─────────────────────────────────────────────────────────────────

_KIND_MAP = {
    "read_file": "read",
    "write_file": "edit",
    "edit_file": "edit",
    "run_command": "execute",
    "search_files": "search",
    "list_directory": "read",
}


def _acp_kind(tool_name: str) -> str:
    return _KIND_MAP.get(tool_name, "other")


def _tool_title(name: str, args: dict) -> str:
    if name in ("read_file", "write_file", "edit_file", "list_directory"):
        return args.get("path", "")
    if name == "run_command":
        cmd = args.get("command", "")
        return cmd[:80] if len(cmd) > 80 else cmd
    if name == "search_files":
        return args.get("pattern", "")
    return ""


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    transport = JsonRpcTransport()
    agent = DevPilotAgent(transport)
    asyncio.run(agent.run())
