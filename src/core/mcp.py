# mcp.py — Playwright MCP subprocess management and .contextos.json injection
import asyncio
import json
from pathlib import Path


# ── MCP config that gets written into the project's .contextos.json ───────────────

PLAYWRIGHT_MCP_CONFIG = {
    "mcpServers": {
        "playwright": {
            "command": "npx",
            "args": ["@playwright/mcp@latest", "--extension"],
        }
    }
}


# ── Singleton process handle ──────────────────────────────────────────────────

_playwright_proc: asyncio.subprocess.Process | None = None


def is_running() -> bool:
    return _playwright_proc is not None and _playwright_proc.returncode is None


# ── .contextos.json injection ──────────────────────────────────────────────────────

def inject_mcp_config(project_folder: Path, npx_path: str) -> None:
    """
    Write (or merge) MCP server config into the project's .contextos.json.
    Preserves any existing keys the user has set.
    """
    claw_json = project_folder / ".contextos.json"
    existing: dict = {}

    if claw_json.exists():
        try:
            existing = json.loads(claw_json.read_text(encoding="utf-8"))
        except Exception:
            existing = {}

    # Use the detected npx path instead of bare "npx" for reliability
    config = dict(PLAYWRIGHT_MCP_CONFIG)
    config["mcpServers"]["playwright"]["command"] = npx_path or "npx"

    existing.setdefault("mcpServers", {})
    existing["mcpServers"].update(config["mcpServers"])

    claw_json.write_text(json.dumps(existing, indent=2), encoding="utf-8")


def remove_mcp_config(project_folder: Path) -> None:
    """Remove the playwright MCP entry from .contextos.json on session end."""
    claw_json = project_folder / ".contextos.json"
    if not claw_json.exists():
        return
    try:
        data = json.loads(claw_json.read_text(encoding="utf-8"))
        data.get("mcpServers", {}).pop("playwright", None)
        if not data.get("mcpServers"):
            data.pop("mcpServers", None)
        claw_json.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass


# ── Lifecycle ─────────────────────────────────────────────────────────────────

async def start_playwright(npx_path: str) -> bool:
    """
    Start Playwright MCP server as a background process.
    Returns True if started successfully, False otherwise.
    """
    global _playwright_proc

    if is_running():
        return True  # already up

    if not npx_path:
        return False

    try:
        _playwright_proc = await asyncio.create_subprocess_exec(
            npx_path, "@playwright/mcp@latest", "--extension",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            stdin=asyncio.subprocess.DEVNULL,
        )
        # Give it a moment to start
        await asyncio.sleep(1.5)

        if _playwright_proc.returncode is not None:
            # Exited immediately — something went wrong
            _playwright_proc = None
            return False

        return True

    except FileNotFoundError:
        _playwright_proc = None
        return False
    except Exception:
        _playwright_proc = None
        return False


async def stop_playwright() -> None:
    global _playwright_proc
    if _playwright_proc is None:
        return
    try:
        _playwright_proc.terminate()
        await asyncio.wait_for(_playwright_proc.wait(), timeout=5.0)
    except (ProcessLookupError, asyncio.TimeoutError):
        try:
            _playwright_proc.kill()
        except ProcessLookupError:
            pass
    finally:
        _playwright_proc = None


async def stop_all() -> None:
    await stop_playwright()


def status() -> dict:
    return {
        "playwright": {
            "running": is_running(),
            "pid": _playwright_proc.pid if is_running() else None,
        }
    }
