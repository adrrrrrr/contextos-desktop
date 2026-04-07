# agent.py — contextos subprocess management and output streaming
import asyncio
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, Literal


SessionState = Literal["idle", "starting", "running", "error"]


# ── Session object ─────────────────────────────────────────────────────────────

@dataclass
class AgentSession:
    session_id:     str
    project_folder: Path
    model:          str
    state:          SessionState = "idle"
    turn_count:     int          = 0      # how many prompts sent this session
    _process:       asyncio.subprocess.Process | None = field(default=None, repr=False)


# ── Module-level singleton (one session at a time for MVP) ────────────────────

_active: AgentSession | None = None


def get_active() -> AgentSession | None:
    return _active


def clear_active() -> None:
    global _active
    _active = None


# ── Core runner ───────────────────────────────────────────────────────────────

async def run_prompt(
    *,
    claw_binary:  str,
    folder:       Path,
    model:        str,
    message:      str,
    session:      AgentSession,
    on_chunk:     Callable[[str], Awaitable[None]],   # async callback, called per output line
) -> int:
    """
    Spawn a claw `prompt` subprocess, stream its stdout to on_chunk(),
    and return the exit code.

    Strategy:
      - First turn  → `claw prompt "msg" --model M --permission-mode danger-full-access`
      - Later turns → `claw --resume latest prompt "msg" ...`
    This preserves session history across turns while keeping each invocation clean.
    """
    args = [claw_binary]

    if session.turn_count > 0:
        args += ["--resume", "latest"]

    args += [
        "prompt", message,
        "--model", model,
        "--permission-mode", "danger-full-access",
        "--output-format", "text",
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(folder),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,  # merge stderr → same stream
            stdin=asyncio.subprocess.DEVNULL,
        )

        session._process = proc
        session.state    = "running"

        # Stream output line-by-line
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            await on_chunk(line)

        await proc.wait()
        session._process = None
        session.turn_count += 1
        return proc.returncode or 0

    except FileNotFoundError:
        on_chunk("⚠  claw binary not found. Check your setup.")
        session.state = "error"
        return 1
    except Exception as exc:
        on_chunk(f"⚠  Agent error: {exc}")
        session.state = "error"
        return 1


# ── Session lifecycle ─────────────────────────────────────────────────────────

def create_session(folder: Path, model: str) -> AgentSession:
    global _active
    session = AgentSession(
        session_id=str(uuid.uuid4())[:8],
        project_folder=folder,
        model=model,
        state="idle",
    )
    _active = session
    return session


async def stop_session() -> None:
    """Terminate the active session's subprocess if running."""
    global _active
    if _active and _active._process:
        try:
            _active._process.terminate()
            await asyncio.wait_for(_active._process.wait(), timeout=5.0)
        except (ProcessLookupError, asyncio.TimeoutError):
            try:
                _active._process.kill()
            except ProcessLookupError:
                pass
        _active._process = None
    _active = None
