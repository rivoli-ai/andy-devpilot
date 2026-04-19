"""
DevPilot Agent Tools

Defines tool schemas (OpenAI function-calling format) and execution logic
for the headless coding agent.  Every tool operates within a sandboxed
project directory and enforces path-traversal protection.
"""

import os
import subprocess
import time
from pathlib import Path
from typing import Any

MAX_OUTPUT_CHARS = 50_000
COMMAND_TIMEOUT_S = 120

# ── Tool schemas (OpenAI function-calling format) ─────────────────────────────

SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": (
                "Read the full contents of a file.  Always read a file before "
                "editing it so you understand the existing code."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the project root",
                    }
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create a new file or completely overwrite an existing one.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the project root",
                    },
                    "content": {
                        "type": "string",
                        "description": "Complete file content",
                    },
                },
                "required": ["path", "content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": (
                "Replace one exact occurrence of old_text with new_text in a file.  "
                "Include enough surrounding context so old_text is unique."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the project root",
                    },
                    "old_text": {
                        "type": "string",
                        "description": "Exact text to find (must appear exactly once)",
                    },
                    "new_text": {
                        "type": "string",
                        "description": "Replacement text",
                    },
                },
                "required": ["path", "old_text", "new_text"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": (
                "Execute a shell command in the project directory.  "
                "Use for builds, tests, dependency installs, or any CLI task.  "
                "For long-running processes (npm start, ng serve, vite, next dev, "
                "webpack --watch, etc.), set background=true so the command detaches "
                "and does not block further tool use or chat; output is written to a log file under .devpilot/agent-logs/."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Shell command to execute",
                    },
                    "background": {
                        "type": "boolean",
                        "description": (
                            "If true, run detached in a new session (stdin closed, output to a log file). "
                            "Required for dev servers and watchers that never exit on their own."
                        ),
                        "default": False,
                    },
                },
                "required": ["command"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_files",
            "description": (
                "Search for a regex pattern across project files.  "
                "Returns matching lines with paths and line numbers."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regex pattern to search for",
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory to search in, relative to project root",
                        "default": ".",
                    },
                    "include": {
                        "type": "string",
                        "description": "Glob filter for filenames (e.g. '*.py')",
                        "default": "",
                    },
                },
                "required": ["pattern"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": "List files and subdirectories at a given path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Directory relative to the project root",
                        "default": ".",
                    }
                },
                "required": [],
                "additionalProperties": False,
            },
        },
    },
]

# ── Helpers ───────────────────────────────────────────────────────────────────


def _safe_resolve(relative_path: str, project_root: str) -> Path:
    """Resolve *relative_path* inside *project_root*, blocking traversal."""
    base = Path(project_root).resolve()
    target = (base / relative_path).resolve()
    if not str(target).startswith(str(base)):
        raise PermissionError(f"Path escapes project root: {relative_path}")
    return target


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n\n… truncated ({len(text)} total chars)"


# ── Individual tool implementations ──────────────────────────────────────────


def _read_file(path: str, root: str) -> str:
    target = _safe_resolve(path, root)
    if not target.exists():
        return f"Error: file not found – {path}"
    if not target.is_file():
        return f"Error: not a regular file – {path}"
    return _truncate(target.read_text(encoding="utf-8", errors="replace"))


def _write_file(path: str, content: str, root: str) -> str:
    target = _safe_resolve(path, root)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"Wrote {path} ({len(content)} chars)"


def _edit_file(path: str, old_text: str, new_text: str, root: str) -> str:
    target = _safe_resolve(path, root)
    if not target.exists():
        return f"Error: file not found – {path}"
    content = target.read_text(encoding="utf-8")
    occurrences = content.count(old_text)
    if occurrences == 0:
        return f"Error: old_text not found in {path}"
    if occurrences > 1:
        return (
            f"Error: old_text matches {occurrences} locations in {path}. "
            "Include more surrounding context to make it unique."
        )
    target.write_text(content.replace(old_text, new_text, 1), encoding="utf-8")
    return f"Edited {path}"


def _coerce_background(raw: Any) -> bool:
    if raw is True:
        return True
    if raw is False or raw is None:
        return False
    if isinstance(raw, str):
        return raw.strip().lower() in ("1", "true", "yes", "on")
    return bool(raw)


def _run_command_background(command: str, root: str) -> str:
    """Start *command* detached; return pid and log path (does not block on exit)."""
    base = Path(root).resolve()
    log_dir = base / ".devpilot" / "agent-logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return f"Error: could not create log directory: {exc}"

    log_path = log_dir / f"cmd-{time.time_ns()}.log"
    try:
        with open(log_path, "w", encoding="utf-8") as logf:
            proc = subprocess.Popen(
                command,
                shell=True,
                cwd=str(base),
                stdout=logf,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
                env={**os.environ, "TERM": "dumb"},
            )
    except Exception as exc:
        return f"Error: failed to start background command: {exc}"

    rel = log_path.relative_to(base).as_posix()
    time.sleep(0.4)
    peek = ""
    try:
        if log_path.exists() and log_path.stat().st_size > 0:
            peek = log_path.read_text(encoding="utf-8", errors="replace")[:4000]
            if len(peek) >= 4000:
                peek += "\n… (truncated; use read_file on the log path for full output)"
    except OSError:
        peek = "(output not readable yet; try read_file on the log path in a moment)"

    parts = [
        "status=running_in_background",
        f"pid={proc.pid}",
        f"log_file={rel}",
        "The process keeps running; use read_file on log_file to inspect output.",
    ]
    if peek.strip():
        parts.append("--- initial output ---")
        parts.append(peek)
    return _truncate("\n".join(parts))


def _run_command(command: str, root: str, background: bool = False) -> str:
    if background:
        return _run_command_background(command, root)

    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=root,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_S,
            env={**os.environ, "TERM": "dumb"},
        )
    except subprocess.TimeoutExpired:
        return (
            f"Error: command timed out after {COMMAND_TIMEOUT_S}s. "
            "If this is a dev server or long-running task, re-run with background=true."
        )

    parts: list[str] = [f"exit_code={proc.returncode}"]
    if proc.stdout:
        parts.append(proc.stdout)
    if proc.stderr:
        parts.append(f"--- stderr ---\n{proc.stderr}")
    return _truncate("\n".join(parts))


def _search_files(pattern: str, path: str, include: str, root: str) -> str:
    target = _safe_resolve(path, root)
    cmd: list[str] = ["grep", "-rn", "--color=never"]
    if include:
        cmd += ["--include", include]
    cmd += [pattern, str(target)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30, cwd=root)
    except subprocess.TimeoutExpired:
        return "Error: search timed out"
    output = proc.stdout or "(no matches)"
    output = output.replace(str(Path(root).resolve()) + "/", "")
    return _truncate(output)


def _list_directory(path: str, root: str) -> str:
    target = _safe_resolve(path, root)
    if not target.exists():
        return f"Error: directory not found – {path}"
    if not target.is_dir():
        return f"Error: not a directory – {path}"
    entries = sorted(target.iterdir())
    base = Path(root).resolve()
    lines = [
        f"{entry.relative_to(base)}{'/' if entry.is_dir() else ''}"
        for entry in entries[:300]
    ]
    if len(entries) > 300:
        lines.append(f"… {len(entries)} total entries")
    return "\n".join(lines) or "(empty directory)"


# ── Public dispatch ───────────────────────────────────────────────────────────

_DISPATCH = {
    "read_file": lambda a, r: _read_file(a["path"], r),
    "write_file": lambda a, r: _write_file(a["path"], a["content"], r),
    "edit_file": lambda a, r: _edit_file(a["path"], a["old_text"], a["new_text"], r),
    "run_command": lambda a, r: _run_command(
        a["command"], r, _coerce_background(a.get("background", False))
    ),
    "search_files": lambda a, r: _search_files(
        a["pattern"], a.get("path", "."), a.get("include", ""), r
    ),
    "list_directory": lambda a, r: _list_directory(a.get("path", "."), r),
}


def execute(name: str, arguments: dict[str, Any], project_root: str) -> str:
    """Execute a tool by *name* and return the result as a plain string."""
    handler = _DISPATCH.get(name)
    if handler is None:
        return f"Error: unknown tool – {name}"
    try:
        return handler(arguments, project_root)
    except PermissionError as exc:
        return f"Error: {exc}"
    except Exception as exc:
        return f"Error executing {name}: {exc}"
