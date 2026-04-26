"""
DevPilot Headless Agent Loop

Drives an LLM through iterative tool-use until the task is complete.
Shared by both the Bridge ``/agent/prompt`` endpoint (sync) and the
ACP agent for Zed (via callback).
"""

import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Callable, Optional

# Optional: checked each iteration and during LLM streaming (headless + abort).
ShouldAbort = Optional[Callable[[], bool]]

from . import tools

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are DevPilot, an expert software engineer working inside a sandboxed \
development environment.

Project root: {project_path}

You have tools for reading, writing, and editing files, running shell \
commands, and searching the codebase.

Rules:
1. Always read a file before editing it.
2. Use edit_file for surgical changes; use write_file for new files or \
   complete rewrites.
3. Run tests or build commands after making changes when a test suite exists.
4. For dev servers, watchers, or any command that runs until interrupted \
   (npm start, vite, next dev, ng serve, etc.), use run_command with \
   background=true so the session is not blocked; read the log file path \
   returned if you need output.
5. When finished, provide a concise summary of what you did and why.
"""

MAX_ITERATIONS = 30


@dataclass
class ToolExecution:
    """Record of a single tool invocation."""
    name: str
    arguments: dict[str, Any]
    result: str
    duration_ms: int = 0


@dataclass
class AgentResult:
    """Final output of a headless agent run."""
    content: str
    tool_executions: list[ToolExecution] = field(default_factory=list)
    model: str = ""
    iterations: int = 0
    prompt_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])


ToolCallback = Callable[[str, dict[str, Any], str], None]
AssistantStreamCallback = Callable[[str], None]


def build_headless_chat_history(
    zed_conversations: list[dict[str, Any]],
    *,
    max_turns: int = 6,
    max_message_chars: int = 6000,
) -> list[dict[str, Any]]:
    """Convert stored ``headless_agent`` bridge entries into user/assistant pairs.

    Tool-only turns (no final assistant text) get a short synthetic summary so
    roles stay alternating for the chat API.
    """
    out: list[dict[str, Any]] = []

    def _clip(text: str) -> str:
        if len(text) <= max_message_chars:
            return text
        return text[: max_message_chars - 24] + "\n… [truncated]"

    for c in zed_conversations:
        if c.get("source") != "headless_agent":
            continue
        user_text = (c.get("user_message") or "").strip()
        if not user_text:
            continue
        assistant_text = (c.get("assistant_message") or "").strip()
        if not assistant_text:
            tcs = c.get("tool_calls") or []
            if tcs:
                names = ", ".join(
                    str((tc or {}).get("name", "?")) for tc in tcs[:16]
                )
                assistant_text = (
                    f"[Prior turn used tools only: {names}. "
                    "Refer to the conversation above and the repo state.]"
                )
            else:
                assistant_text = "(Prior turn had no assistant reply.)"

        out.append({"role": "user", "content": _clip(user_text)})
        out.append({"role": "assistant", "content": _clip(assistant_text)})

    cap = max(0, max_turns) * 2
    if len(out) > cap:
        out = out[-cap:]
    return out


def normalize_client_conversation_history(
    raw: Any,
    *,
    max_turns: int = 6,
    max_message_chars: int = 6000,
) -> list[dict[str, Any]]:
    """Validate JSON ``conversation_history`` from POST /agent/prompt (user/assistant turns).

    Used when the UI restored prior turns from the database so the LLM keeps context
    even if in-memory ``zed_conversations`` was cleared.
    """
    if not raw or not isinstance(raw, list):
        return []

    def _clip(text: str) -> str:
        if len(text) <= max_message_chars:
            return text
        return text[: max_message_chars - 24] + "\n… [truncated]"

    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role not in ("user", "assistant"):
            continue
        if not isinstance(content, str):
            continue
        text = content.strip()
        if not text:
            continue
        out.append({"role": role, "content": _clip(text)})

    cap = max(0, max_turns) * 2
    if len(out) > cap:
        out = out[-cap:]
    return out


def _assistant_dict(message: Any) -> dict[str, Any]:
    """Convert an SDK ChatCompletionMessage to a plain dict for the messages list."""
    msg: dict[str, Any] = {"role": "assistant", "content": message.content}
    if message.tool_calls:
        msg["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.function.name,
                    "arguments": tc.function.arguments,
                },
            }
            for tc in message.tool_calls
        ]
    return msg


def _pick(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _stream_delta_content(d: Any) -> str:
    v = _pick(d, "content")
    if v is None:
        return ""
    return str(v)


def _stream_delta_tool_calls(d: Any) -> list[Any]:
    v = _pick(d, "tool_calls")
    if not v:
        return []
    return list(v)


def _tool_chunk_index(tc: Any) -> int:
    idx = _pick(tc, "index")
    return int(idx) if idx is not None else 0


def _tool_chunk_apply(tool_acc: dict[int, dict[str, str]], tc: Any) -> None:
    idx = _tool_chunk_index(tc)
    if idx not in tool_acc:
        tool_acc[idx] = {"id": "", "name": "", "arguments": ""}
    tid = _pick(tc, "id")
    if tid:
        tool_acc[idx]["id"] = str(tid)
    fn = _pick(tc, "function")
    if fn is not None:
        name = _pick(fn, "name")
        if name:
            tool_acc[idx]["name"] = str(name)
        args = _pick(fn, "arguments")
        if args:
            tool_acc[idx]["arguments"] += str(args)


def _message_from_stream(
    llm_client: Any,
    model: str,
    messages: list[dict[str, Any]],
    *,
    on_assistant_delta: Optional[AssistantStreamCallback] = None,
    should_abort: ShouldAbort = None,
) -> Any:
    """One chat completion with ``stream=True``; returns an object like ``choice.message``."""
    accumulated = ""
    tool_acc: dict[int, dict[str, str]] = {}
    stream = llm_client.chat.completions.create(
        model=model,
        messages=messages,
        tools=tools.SCHEMAS,
        stream=True,
    )
    for chunk in stream:
        if should_abort is not None and should_abort():
            if on_assistant_delta is not None and accumulated:
                on_assistant_delta(accumulated + "\n\n[Stopped by user.]")
            return SimpleNamespace(
                content=accumulated or "Stopped by user.",
                tool_calls=None,
            )
        if not chunk.choices:
            continue
        ch0 = chunk.choices[0]
        d = ch0.delta
        content = _stream_delta_content(d)
        if content:
            accumulated += content
            if on_assistant_delta is not None:
                on_assistant_delta(accumulated)
        for tc in _stream_delta_tool_calls(d):
            _tool_chunk_apply(tool_acc, tc)

    if tool_acc:
        lst: list[Any] = []
        for idx in sorted(tool_acc.keys()):
            t = tool_acc[idx]
            tid = t["id"] or f"call_{idx}"
            lst.append(
                SimpleNamespace(
                    id=tid,
                    function=SimpleNamespace(
                        name=t["name"],
                        arguments=t["arguments"] or "{}",
                    ),
                )
            )
        return SimpleNamespace(
            content=accumulated if accumulated else None,
            tool_calls=lst,
        )
    return SimpleNamespace(content=accumulated or None, tool_calls=None)


def run(
    prompt: str,
    project_path: str,
    llm_client: Any,
    model: str,
    *,
    max_iterations: int = MAX_ITERATIONS,
    on_tool_call: Optional[ToolCallback] = None,
    on_assistant_delta: Optional[AssistantStreamCallback] = None,
    conversation_history: Optional[list[dict[str, Any]]] = None,
    should_abort: ShouldAbort = None,
) -> AgentResult:
    """Execute the agent loop synchronously.

    Parameters
    ----------
    prompt:
        The user's request.
    project_path:
        Absolute path to the project directory inside the sandbox.
    llm_client:
        An OpenAI-compatible client (``openai.OpenAI``).
    model:
        Model identifier (e.g. ``"gpt-4o"``).
    max_iterations:
        Safety cap on LLM round-trips.
    on_tool_call:
        Optional ``(tool_name, arguments, result) -> None`` callback
        invoked after every tool execution (used by the ACP agent to
        stream progress to Zed).
    on_assistant_delta:
        If set, LLM calls use streaming; invoked with accumulated assistant
        text for the current turn (for live UIs). Tool rounds reset before
        the next stream.
    conversation_history:
        Optional prior turns as OpenAI-style ``user`` / ``assistant`` dicts
        (no ``system``). Inserted after the system prompt and before ``prompt``.

    Returns
    -------
    AgentResult
        The assistant's final text together with a log of every tool
        invocation.
    """
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT.format(project_path=project_path)},
    ]
    if conversation_history:
        messages.extend(conversation_history)
    messages.append({"role": "user", "content": prompt})

    result = AgentResult(content="", model=model)

    for iteration in range(max_iterations):
        result.iterations = iteration + 1
        logger.info("agent loop iteration %d/%d", result.iterations, max_iterations)

        if should_abort is not None and should_abort():
            result.content = "Stopped by user."
            return result

        try:
            if on_assistant_delta is not None:
                on_assistant_delta("")
                try:
                    message = _message_from_stream(
                        llm_client,
                        model,
                        messages,
                        on_assistant_delta=on_assistant_delta,
                        should_abort=should_abort,
                    )
                except Exception as stream_exc:
                    logger.warning(
                        "LLM streaming failed (%s), falling back to non-streaming",
                        stream_exc,
                    )
                    if should_abort is not None and should_abort():
                        result.content = "Stopped by user."
                        return result
                    response = llm_client.chat.completions.create(
                        model=model,
                        messages=messages,
                        tools=tools.SCHEMAS,
                    )
                    message = response.choices[0].message
                    if on_assistant_delta is not None:
                        piece = message.content or ""
                        if piece:
                            on_assistant_delta(piece)
            else:
                if should_abort is not None and should_abort():
                    result.content = "Stopped by user."
                    return result
                response = llm_client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=tools.SCHEMAS,
                )
                message = response.choices[0].message
        except Exception as exc:
            logger.error("LLM request failed: %s", exc)
            result.content = f"LLM error: {exc}"
            return result

        messages.append(_assistant_dict(message))

        if not message.tool_calls:
            result.content = message.content or ""
            return result

        for tc in message.tool_calls:
            if should_abort is not None and should_abort():
                result.content = "Stopped by user."
                return result
            try:
                args = json.loads(tc.function.arguments)
            except json.JSONDecodeError:
                args = {}

            t0 = time.monotonic()
            tool_result = tools.execute(tc.function.name, args, project_path)
            elapsed_ms = int((time.monotonic() - t0) * 1000)

            result.tool_executions.append(
                ToolExecution(
                    name=tc.function.name,
                    arguments=args,
                    result=tool_result[:2000],
                    duration_ms=elapsed_ms,
                )
            )

            logger.info("tool %s completed in %dms", tc.function.name, elapsed_ms)

            if on_tool_call is not None:
                on_tool_call(tc.function.name, args, tool_result)

            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": tool_result,
            })

    result.content = "Reached maximum iterations without completing."
    return result
