# config.py — Platform detection, app settings, recent folders
import json
import shutil
import socket
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path


# ── Platform ──────────────────────────────────────────────────────────────────

IS_WINDOWS = sys.platform == "win32"
IS_MAC     = sys.platform == "darwin"

# Config dir: ~/.contextos-desktop/
CONFIG_DIR  = Path.home() / ".contextos-desktop"
CONFIG_FILE = CONFIG_DIR / "config.json"

# ── Dataclass ─────────────────────────────────────────────────────────────────

@dataclass
class ProjectConfig:
    """A saved project — remembers folder + preferred provider/model."""
    folder:        str        = ""
    name:          str        = ""      # display name (defaults to folder basename)
    provider_id:   str        = ""
    model:         str        = ""
    last_used:     str        = ""      # ISO timestamp
    extra_folders: list[str]  = field(default_factory=list)  # additional mounted folders (e.g. Downloads)


@dataclass
class AppConfig:
    recent_folders:         list[str]           = field(default_factory=list)
    projects:               list[ProjectConfig] = field(default_factory=list)
    npx_path:               str                 = ""
    port:                   int                 = 8080
    playwright_mcp_enabled: bool                = False


# ── Helpers ───────────────────────────────────────────────────────────────────

def _find_binary(names: list[str]) -> str:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return ""


def _find_npx() -> str:
    return _find_binary(["npx", "npx.cmd"])


def _next_free_port(start: int = 8080) -> int:
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return start


# ── Load / Save ───────────────────────────────────────────────────────────────

def load_config() -> AppConfig:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    cfg = AppConfig()

    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            cfg.recent_folders = data.get("recent_folders", [])
            cfg.npx_path       = data.get("npx_path", "")
            # Deserialize saved projects
            for p in data.get("projects", []):
                cfg.projects.append(ProjectConfig(
                    folder=p.get("folder", ""),
                    name=p.get("name", ""),
                    provider_id=p.get("provider_id", ""),
                    model=p.get("model", ""),
                    last_used=p.get("last_used", ""),
                    extra_folders=p.get("extra_folders", []),
                ))
        except Exception:
            pass

    if not cfg.npx_path or not Path(cfg.npx_path).is_file():
        cfg.npx_path = _find_npx()

    cfg.playwright_mcp_enabled = bool(cfg.npx_path)
    cfg.port = _next_free_port(8080)
    return cfg


def save_config(cfg: AppConfig) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    data = {
        "recent_folders": cfg.recent_folders,
        "npx_path": cfg.npx_path,
        "projects": [asdict(p) for p in cfg.projects],
    }
    CONFIG_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


# ── Recent Folders ────────────────────────────────────────────────────────────

def add_recent_folder(cfg: AppConfig, folder: str) -> None:
    folder = str(Path(folder))
    if folder in cfg.recent_folders:
        cfg.recent_folders.remove(folder)
    cfg.recent_folders.insert(0, folder)
    cfg.recent_folders = cfg.recent_folders[:10]
    save_config(cfg)


def validate_folder(folder: str) -> dict:
    p = Path(folder)
    if not p.exists():
        return {"valid": False, "has_claude_md": False, "error": "Folder does not exist"}
    if not p.is_dir():
        return {"valid": False, "has_claude_md": False, "error": "Path is not a folder"}
    has_md = (p / "CLAUDE.md").is_file()
    return {"valid": True, "has_claude_md": has_md, "error": None}


# ── Folder resolver ──────────────────────────────────────────────────────

def resolve_folder_name(name: str, recent_folders: list[str] | None = None) -> str | None:
    """Try to find a folder by name in common locations. Returns real path or None.

    Strategy:
    1. Check if already an absolute path
    2. Check recent folders
    3. Check saved projects (config)
    4. Check common base dirs (direct child)
    5. Walk home directory up to 4 levels deep
    6. Fallback: use 'find' command with timeout (macOS/Linux)
    """
    if not name or name == ".":
        return None
    # If it's already a valid absolute path, return it
    p = Path(name)
    if p.is_absolute() and p.is_dir():
        return str(p)

    # Check recent folders first — most likely match
    for rf in (recent_folders or []):
        rp = Path(rf)
        if rp.name == name and rp.is_dir():
            return str(rp)

    # Check saved projects in config
    try:
        cfg = load_config()
        for proj in cfg.projects:
            pp = Path(proj.folder)
            if pp.name == name and pp.is_dir():
                return str(pp)
            # Also check if this project's folder ends with the name
            if proj.folder.endswith("/" + name) and pp.is_dir():
                return str(pp)
    except Exception:
        pass

    # Search common locations under home directory
    home = Path.home()
    search_bases = [
        home,
        home / "Documents",
        home / "Desktop",
        home / "Projects",
        home / "Developer",
        home / "Code",
        home / "dev",
        home / "repos",
        home / "workspace",
        home / "Downloads",
        home / "Sites",
        home / "Work",
        home / "src",
        home / "github",
    ]
    for base in search_bases:
        candidate = base / name
        if candidate.is_dir():
            return str(candidate)

    # Walk home directory up to 4 levels deep (covers most project structures)
    SKIP = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist',
            'build', '.next', '.cache', 'Library', '.Trash', 'Applications'}
    try:
        def _walk(base: Path, depth: int, max_depth: int = 4):
            if depth > max_depth:
                return None
            try:
                for child in base.iterdir():
                    if not child.is_dir():
                        continue
                    cname = child.name
                    if cname.startswith('.') and depth > 0:
                        continue
                    if cname in SKIP:
                        continue
                    if cname == name:
                        return str(child)
                    found = _walk(child, depth + 1, max_depth)
                    if found:
                        return found
            except (PermissionError, OSError):
                pass
            return None

        found = _walk(home, 0)
        if found:
            return found
    except Exception:
        pass

    # Fallback for macOS/Linux: use 'find' command with short timeout
    if not IS_WINDOWS:
        import subprocess
        try:
            result = subprocess.run(
                ['find', str(home), '-maxdepth', '5', '-type', 'd', '-name', name, '-not', '-path', '*/.*'],
                capture_output=True, text=True, timeout=5
            )
            for line in result.stdout.strip().split('\n'):
                line = line.strip()
                if line and Path(line).is_dir():
                    return line
        except (subprocess.TimeoutExpired, FileNotFoundError, Exception):
            pass

    return None


# ── Project persistence ───────────────────────────────────────────────────

def upsert_project(
    cfg: AppConfig, folder: str, provider_id: str, model: str,
    name: str = "", extra_folders: list[str] | None = None,
) -> ProjectConfig:
    """Save or update a project. Returns the project config."""
    from datetime import datetime as _dt
    folder = str(Path(folder))
    now = _dt.utcnow().isoformat()

    # Find existing project by folder
    for p in cfg.projects:
        if p.folder == folder:
            if provider_id: p.provider_id = provider_id
            if model:       p.model = model
            p.last_used = now
            if name:
                p.name = name
            if extra_folders is not None:
                p.extra_folders = [str(Path(f)) for f in extra_folders]
            save_config(cfg)
            return p

    # Create new
    proj = ProjectConfig(
        folder=folder,
        name=name or Path(folder).name,
        provider_id=provider_id,
        model=model,
        last_used=now,
        extra_folders=[str(Path(f)) for f in (extra_folders or [])],
    )
    cfg.projects.insert(0, proj)
    if len(cfg.projects) > 20:
        cfg.projects.pop()
    save_config(cfg)
    return proj


def get_projects(cfg: AppConfig) -> list[dict]:
    """Return projects sorted by last_used (most recent first)."""
    sorted_projects = sorted(cfg.projects, key=lambda p: p.last_used or "", reverse=True)
    return [asdict(p) for p in sorted_projects]


def delete_project(cfg: AppConfig, folder: str) -> bool:
    folder = str(Path(folder))
    before = len(cfg.projects)
    cfg.projects = [p for p in cfg.projects if p.folder != folder]
    if len(cfg.projects) < before:
        save_config(cfg)
        return True
    return False


# ── Startup summary ───────────────────────────────────────────────────────────

def print_startup_info(cfg: AppConfig) -> None:
    print("━" * 52)
    print("  ContextOS Desktop")
    print("━" * 52)
    print(f"  Platform : {'Windows' if IS_WINDOWS else 'macOS' if IS_MAC else 'Linux'}")
    print(f"  Port     : {cfg.port}")
    print(f"  Browser  : {'✓ Playwright MCP' if cfg.playwright_mcp_enabled else '✗ Playwright MCP (install Node.js)'}")
    print("━" * 52)
