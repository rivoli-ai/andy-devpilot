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
from typing import Any, Callable, Optional

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
4. When finished, provide a concise summary of what you did and why.
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


def run(
    prompt: str,
    project_path: str,
    llm_client: Any,
    model: str,
    *,
    max_iterations: int = MAX_ITERATIONS,
    on_tool_call: Optional[ToolCallback] = None,
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

    Returns
    -------
    AgentResult
        The assistant's final text together with a log of every tool
        invocation.
    """
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT.format(project_path=project_path)},
        {"role": "user", "content": prompt},
    ]

    result = AgentResult(content="", model=model)

    for iteration in range(max_iterations):
        result.iterations = iteration + 1
        logger.info("agent loop iteration %d/%d", result.iterations, max_iterations)

        try:
            response = llm_client.chat.completions.create(
                model=model,
                messages=messages,
                tools=tools.SCHEMAS,
            )
        except Exception as exc:
            logger.error("LLM request failed: %s", exc)
            result.content = f"LLM error: {exc}"
            return result

        choice = response.choices[0]
        messages.append(_assistant_dict(choice.message))

        if not choice.message.tool_calls:
            result.content = choice.message.content or ""
            return result

        for tc in choice.message.tool_calls:
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
