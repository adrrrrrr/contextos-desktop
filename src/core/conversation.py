# conversation.py — Session management + agentic tool execution.
# Auto-loads Context OS memory into system prompt.
# Provides read_file / list_files / write_file tools so the model can
# follow the Context OS cascade loading protocol mid-conversation.
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path


# ── Tool definitions (OpenAI-compatible function calling format) ──────────────

AGENT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": (
                "Read a file from the project folder. Use this to load additional "
                "context files, skills, protocols, or any project file as directed "
                "by CLAUDE.md's loading protocol. Returns the file content as text."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from the project root (e.g. '_skills/negotiation/SKILL.md', '_protocols/maintenance.md')",
                    }
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": (
                "List files and directories in a project folder. Use to discover "
                "what's available before reading specific files."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "directory": {
                        "type": "string",
                        "description": "Relative directory path from project root. Use '.' or '' for root.",
                    }
                },
                "required": ["directory"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": (
                "Create or update a file in the project folder. Use for ALL file writes: "
                "memory updates (_memory/recent.md, SESSION-INDEX.md), session records, "
                "deliverables, documents, code, configs. The file will be saved to disk "
                "and appear in the user's Working folders panel."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from project root",
                    },
                    "content": {
                        "type": "string",
                        "description": "Full file content to write",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
]


# ── Tool execution ───────────────────────────────────────────────────────────

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next"}


def execute_tool(folder: Path, tool_name: str, tool_args: dict, extra_folders: list[Path] | None = None) -> str:
    """Execute a tool call and return the result string."""
    if tool_name == "read_file":
        result = _read_project_file(folder, tool_args.get("path", ""))
        # If not found in main folder, search extra folders
        if result.startswith("Error: File not found") and extra_folders:
            for ef in extra_folders:
                alt = _read_project_file(ef, tool_args.get("path", ""))
                if not alt.startswith("Error"):
                    return alt
        return result
    elif tool_name == "list_files":
        return _list_project_files(folder, tool_args.get("directory", "."))
    elif tool_name == "write_file":
        return _write_project_file(folder, tool_args.get("path", ""), tool_args.get("content", ""))
    return f"Unknown tool: {tool_name}"


def _read_project_file(folder: Path, rel_path: str) -> str:
    try:
        fp = (folder / rel_path).resolve()
        root = folder.resolve()
        if not str(fp).startswith(str(root)):
            return "Error: Access denied — path outside project folder"
        if not fp.is_file():
            return f"Error: File not found: {rel_path}"
        if fp.stat().st_size > 500_000:
            return "Error: File too large (>500KB)"
        return fp.read_text(encoding="utf-8")
    except Exception as e:
        return f"Error reading file: {e}"


def _list_project_files(folder: Path, rel_dir: str) -> str:
    try:
        target = (folder / (rel_dir or ".")).resolve()
        root = folder.resolve()
        if not str(target).startswith(str(root)):
            return "Error: Access denied"
        if not target.is_dir():
            return f"Error: Not a directory: {rel_dir}"
        items = []
        for item in sorted(target.iterdir()):
            if item.name.startswith(".") and item.name not in (".contextos-local",):
                continue
            if item.name in SKIP_DIRS:
                continue
            kind = "dir" if item.is_dir() else "file"
            items.append(f"[{kind}] {item.name}")
        return "\n".join(items) if items else "(empty directory)"
    except Exception as e:
        return f"Error: {e}"


def _write_project_file(folder: Path, rel_path: str, content: str) -> str:
    try:
        fp = (folder / rel_path).resolve()
        root = folder.resolve()
        if not str(fp).startswith(str(root)):
            return "Error: Access denied — path outside project folder"
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content, encoding="utf-8")
        return f"OK — written {rel_path} ({len(content)} chars)"
    except Exception as e:
        return f"Error writing file: {e}"


# ── File creation: legacy XML format (kept as fallback) ──────────────────────

FILE_CREATION_INSTRUCTIONS = """
## Tools Available — READ THIS CAREFULLY

You have **function calling tools** to interact with the project filesystem. Use them by making tool calls (NOT by writing XML tags in your response text).

Available tools:
- **read_file(path)** — Read any file from the project. Use this when CLAUDE.md says "READ → path".
- **list_files(directory)** — List files/dirs in a project folder. Use '.' for root.
- **write_file(path, content)** — Create or update any file. Use for memory updates, deliverables, code, etc.

### CRITICAL RULES FOR FILE OPERATIONS:

1. **USE THE FUNCTION CALLING TOOLS.** Do NOT write XML tags like `<execute_write_file>` or `<create_file>` in your response text — those are NOT real tools and will NOT save files. Instead, call the actual `write_file` tool via function calling.

2. **When CLAUDE.md or identity.md says "READ → path"**, call the `read_file` tool to actually load it. Follow the full cascade loading protocol — read what you need, when you need it.

3. **When updating memory** (_memory/recent.md, SESSION-INDEX.md, etc.), call `write_file` with the full updated content. The file will be saved to disk and persist across sessions.

4. **Do NOT just describe what you would write** — actually call write_file to make it happen.

5. **At the end of every session** (when the user says "finish session", "close", "done", etc.), you MUST call write_file to update the memory files as described in the loading protocol (Step 5). This is how persistence works.

6. **ALWAYS read before writing (verify first).** Before updating ANY existing file, you MUST call `read_file` first to see the current content. Never overwrite a file blind. This follows the same pattern Claude Code uses — verify the current state before making any changes. This is critical for data integrity and prevents accidental data loss.

7. **Persist every change.** When you modify information, update memory, or create deliverables, ALWAYS call `write_file` to save to disk. Changes only persist if written. Do not just describe changes — execute the write.
"""


def parse_file_blocks(text: str) -> list[tuple[str, str]]:
    """
    Extract file-write blocks from an AI response.
    Models that don't use function calling (or where the provider's OpenAI-compat
    endpoint doesn't relay tool_calls) often invent XML-like tags. This parser
    catches the most common patterns:
      <create_file path="...">content</create_file>
      <execute_write_file path="..." content="..."/>   (self-closing)
      <execute_write_file path="...">content</execute_write_file>
      <write_file path="...">content</write_file>
    """
    results = []

    # Pattern 1: <create_file path="...">content</create_file>
    for m in re.finditer(r'<create_file\s+path=["\']([^"\']+)["\']>(.*?)</create_file>', text, re.DOTALL):
        results.append((m.group(1).strip(), m.group(2).strip()))

    # Pattern 2: <execute_write_file path="..." content="..."/>  (self-closing, content as attribute)
    for m in re.finditer(r'<execute_write_file\s+path=["\']([^"\']+)["\']\s+content=["\'](.+?)["\'](?:\s*/)?>', text, re.DOTALL):
        results.append((m.group(1).strip(), m.group(2).strip()))

    # Pattern 3: <execute_write_file path="...">content</execute_write_file>  (body content)
    for m in re.finditer(r'<execute_write_file\s+path=["\']([^"\']+)["\']>(.*?)</execute_write_file>', text, re.DOTALL):
        results.append((m.group(1).strip(), m.group(2).strip()))

    # Pattern 4: <write_file path="...">content</write_file>
    for m in re.finditer(r'<write_file\s+path=["\']([^"\']+)["\']>(.*?)</write_file>', text, re.DOTALL):
        results.append((m.group(1).strip(), m.group(2).strip()))

    # Deduplicate by path (keep first match)
    seen = set()
    deduped = []
    for path, content in results:
        if path not in seen:
            seen.add(path)
            deduped.append((path, content))
    return deduped


def parse_file_reads(text: str) -> list[str]:
    """
    Extract file-read requests from model text output.
    Catches patterns like:
      <execute_read_file path="..."/>
      <read_file path="..."/>
    Returns list of relative paths the model wants to read.
    """
    paths = []
    for m in re.finditer(r'<(?:execute_)?read_file\s+path=["\']([^"\']+)["\'](?:\s*/)?>', text):
        paths.append(m.group(1).strip())
    return paths


def parse_present_files(text: str) -> list[str]:
    """
    Extract file-present requests from model text output.
    Catches: <execute_present_files paths=["a","b"]/>
    Returns list of relative paths.
    """
    paths = []
    for m in re.finditer(r'<execute_present_files\s+paths=\[([^\]]+)\](?:\s*/)?>', text):
        raw = m.group(1)
        # Parse the bracketed list: "a","b","c"
        for p in re.findall(r'["\']([^"\']+)["\']', raw):
            paths.append(p.strip())
    return paths


# ── Context OS files to auto-load at session start ───────────────────────────

CONTEXT_OS_FILES = [
    "CLAUDE.md",
    "_memory/identity.md",
    "_memory/recent.md",
    "_memory/history/SESSION-INDEX.md",
]


def build_system_prompt_from_content(content_dict: dict, extra_folder_names: list[str] | None = None) -> tuple[str, list[str]]:
    """
    Build a lean system prompt that lists available files without injecting their contents.
    The agent reads files on-demand via read_file (like Claude Code does).
    Used when the browser reads files directly via showDirectoryPicker().
    """
    available = [rp for rp in CONTEXT_OS_FILES if rp in content_dict and content_dict[rp].strip()]
    # Also note any extra files beyond the core Context OS files
    extra_available = [rp for rp in content_dict if rp not in CONTEXT_OS_FILES and content_dict[rp].strip()]
    return _build_lean_prompt(available, extra_available, extra_folder_names), available


def build_system_prompt(folder: Path, extra_folders: list[Path] | None = None) -> tuple[str, list[str]]:
    """
    Build a lean system prompt that lists available files without injecting their contents.
    The agent reads files on-demand via read_file (like Claude Code does).
    """
    available = []
    for rel_path in CONTEXT_OS_FILES:
        fp = folder / rel_path
        if fp.is_file():
            available.append(rel_path)

    extra_folder_names = [ef.name for ef in extra_folders] if extra_folders else None
    return _build_lean_prompt(available, [], extra_folder_names), available


def _build_lean_prompt(
    available_files: list[str],
    extra_files: list[str] | None = None,
    extra_folder_names: list[str] | None = None,
) -> str:
    """Build the system prompt without injecting file contents."""
    if not available_files:
        return (
            "You are ContextOS Desktop — an AI agent assistant. "
            "No CLAUDE.md was found in the selected folder, so you have no project context. "
            "Be helpful and concise." + FILE_CREATION_INSTRUCTIONS
        )

    prompt = (
        "You are the ContextOS agent — an AI chief of staff for this project.\n\n"
    )

    if extra_folder_names:
        prompt += f"**Additional folders mounted:** {', '.join(extra_folder_names)}\n\n"

    prompt += (
        "## Available Context OS Files\n\n"
        "The following project files are available. **Your first action on every new conversation "
        "must be to read `CLAUDE.md`** — it contains your loading protocol, identity, rules, "
        "and tells you which other files to read.\n\n"
    )
    for f in available_files:
        prompt += f"- `{f}`\n"
    if extra_files:
        prompt += "\nOther project files:\n"
        for f in extra_files[:10]:
            prompt += f"- `{f}`\n"

    prompt += (
        "\n**IMPORTANT:** Use `read_file` to load these files — their contents are NOT "
        "pre-loaded in this prompt. Read CLAUDE.md first, then follow its cascade loading protocol "
        "to read identity.md, recent.md, etc. as directed.\n"
        "\nOnce you have read the context files, respond to the user normally. "
        "Do NOT tell the user you are reading files — just do it silently before responding.\n"
    )

    prompt += FILE_CREATION_INSTRUCTIONS
    return prompt


# ── Session dataclass ─────────────────────────────────────────────────────────

@dataclass
class ConversationSession:
    session_id:    str
    folder:        Path
    provider_id:   str
    model:         str
    api_key:       str
    system_prompt: str
    loaded_files:  list[str]
    messages:      list[dict] = field(default_factory=list)
    file_cache:    dict[str, str] = field(default_factory=dict)  # browser sessions: cached file contents
    extra_folders: list[Path] = field(default_factory=list)      # additional mounted folders

    def get_llm_messages(self) -> list[dict]:
        """Build the full message list for the LLM call (system + history)."""
        return [{"role": "system", "content": self.system_prompt}] + self.messages

    def add_user(self, content: str) -> None:
        self.messages.append({"role": "user", "content": content})

    def add_assistant(self, content: str) -> None:
        self.messages.append({"role": "assistant", "content": content})

    def add_assistant_with_tool_calls(self, content: str | None, tool_calls: list[dict]) -> None:
        """Add assistant message that contains tool calls."""
        msg = {"role": "assistant", "content": content or ""}
        msg["tool_calls"] = [
            {
                "id": tc["id"],
                "type": "function",
                "function": {"name": tc["name"], "arguments": tc["arguments"]},
            }
            for tc in tool_calls
        ]
        self.messages.append(msg)

    def add_tool_result(self, tool_call_id: str, content: str) -> None:
        """Add a tool result message."""
        self.messages.append({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": content,
        })

    @property
    def turn_count(self) -> int:
        return sum(1 for m in self.messages if m["role"] == "user")

    @property
    def has_real_folder(self) -> bool:
        """True if the folder is a real path on disk (not just a display name)."""
        return self.folder.is_dir()


# ── Session history (in-memory, current run only) ─────────────────────────────

@dataclass
class SessionSummary:
    session_id:   str
    folder_name:  str
    provider_id:  str
    model:        str
    started_at:   str
    turn_count:   int
    snippet:      str


# ── Module-level state ────────────────────────────────────────────────────────

_active:         ConversationSession | None = None
_history:        list[SessionSummary]       = []
_full_sessions:  dict[str, ConversationSession] = {}  # session_id → full session (for switching back)


def get_active() -> ConversationSession | None:
    return _active

def get_history() -> list[SessionSummary]:
    return _history

def _archive_active() -> None:
    global _active
    if _active:
        # Always store full session for later restoration (session switching)
        _full_sessions[_active.session_id] = _active
    if _active and _active.messages:
        first_user = next((m["content"] for m in _active.messages if m["role"] == "user"), "")
        summary = SessionSummary(
            session_id=_active.session_id,
            folder_name=_active.folder.name,
            provider_id=_active.provider_id,
            model=_active.model,
            started_at=datetime.utcnow().isoformat(),
            turn_count=_active.turn_count,
            snippet=first_user[:80] if isinstance(first_user, str) else "",
        )
        _history.insert(0, summary)
        if len(_history) > 50:
            _history.pop()


def create_session(
    folder: Path, provider_id: str, model: str, api_key: str,
    extra_folders: list[Path] | None = None,
) -> ConversationSession:
    global _active
    _archive_active()
    system_prompt, loaded_files = build_system_prompt(folder, extra_folders=extra_folders)
    _active = ConversationSession(
        session_id=str(uuid.uuid4())[:8],
        folder=folder,
        provider_id=provider_id,
        model=model,
        api_key=api_key,
        system_prompt=system_prompt,
        loaded_files=loaded_files,
        extra_folders=extra_folders or [],
    )
    return _active


def create_session_from_content(
    folder_name: str, content_dict: dict,
    provider_id: str, model: str, api_key: str,
    all_files: dict | None = None,
    extra_folder_names: list[str] | None = None,
) -> ConversationSession:
    global _active
    _archive_active()
    system_prompt, loaded_files = build_system_prompt_from_content(
        content_dict, extra_folder_names=extra_folder_names,
    )
    _active = ConversationSession(
        session_id=str(uuid.uuid4())[:8],
        folder=Path(folder_name),
        provider_id=provider_id,
        model=model,
        api_key=api_key,
        system_prompt=system_prompt,
        loaded_files=loaded_files,
        file_cache=all_files or content_dict or {},
    )
    return _active


def clear_session() -> None:
    global _active
    _archive_active()
    _active = None


def switch_to_session(session_id: str) -> ConversationSession | None:
    """Switch to a previously archived session, restoring it as active."""
    global _active
    if _active and _active.session_id == session_id:
        return _active
    if session_id in _full_sessions:
        _archive_active()
        _active = _full_sessions.pop(session_id)
        # Remove from summary history since it's now active again
        _history[:] = [s for s in _history if s.session_id != session_id]
        return _active
    return None
