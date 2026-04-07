# Claw Desktop — Architecture v1 (MVP)

**Version:** 1.0 MVP
**Date:** Apr 5, 2026
**Scope:** Chat UI with streaming + folder picker. Single user (AD). Mac + Windows.
**Status:** LOCKED — this is the blueprint. Changes go in v2.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     USER'S CHROME                           │
│  ┌─────────────────────────────────────┐                    │
│  │    localhost:8080 (Claw Desktop UI)  │                    │
│  │    HTML/JS + WebSocket client        │                    │
│  └──────────────┬──────────────────────┘                    │
│                 │ WebSocket ws://localhost:8080/ws           │
│  ┌──────────────▼──────────────────────┐                    │
│  │    Playwright MCP Bridge Extension   │                    │
│  │    (controls browser tabs as AD)     │                    │
│  └─────────────────────────────────────┘                    │
└─────────────────┬───────────────────────────────────────────┘
                  │ WebSocket
┌─────────────────▼───────────────────────────────────────────┐
│                  PYTHON FASTAPI BACKEND                      │
│                  (app.py + uvicorn)                          │
│                                                             │
│  ┌──────────────┐   ┌─────────────┐   ┌──────────────────┐ │
│  │  AgentManager │   │  MCPManager │   │   ConfigManager  │ │
│  │  (agent.py)   │   │  (mcp.py)   │   │   (config.py)    │ │
│  └──────┬───────┘   └──────┬──────┘   └──────────────────┘ │
│         │ stdin/stdout       │ subprocess                    │
└─────────┼───────────────────┼─────────────────────────────── ┘
          │                   │
          ▼                   ▼
   ┌─────────────┐    ┌──────────────────┐
   │  claw-code  │    │  npx @playwright/ │
   │  (Rust CLI) │    │  mcp --extension  │
   │             │    │                  │
   │  Reads:     │    │  MCP Tools:      │
   │  CLAUDE.md  │    │  navigate        │
   │  _memory/   │    │  evaluate (JS)   │
   │  _skills/   │    │  click, fill     │
   │             │    │  screenshot      │
   └─────────────┘    └──────────────────┘
```

---

## Component Breakdown

### 1. `src/core/config.py` — Configuration Manager

Responsibilities:
- Detect platform (Mac/Windows)
- Locate claw binary (`shutil.which('claw')` → local path fallback)
- Locate Node.js/npx (`shutil.which('npx')`)
- Load/save app config from `~/.claw-desktop/config.json`
- Manage recent folders list (max 10)
- Find available port (try 8080→8081→8082)

```python
# Key data structures
@dataclass
class AppConfig:
    recent_folders: list[str]       # Last 10 used
    claw_binary_path: str           # Path to claw executable
    npx_path: str                   # Path to npx
    default_model: str              # "claude-opus-4-6" default
    port: int                       # 8080 (or next available)
    playwright_mcp_enabled: bool    # True if npx available
```

### 2. `src/core/agent.py` — Agent Manager

Responsibilities:
- Spawn claw-code subprocess in REPL mode
- Stream stdout line-by-line to a callback
- Write user prompts to stdin
- Track session state (idle/starting/running/error)
- Clean shutdown (send quit command, then terminate)

```python
# Key interface
class AgentSession:
    session_id: str
    project_folder: Path
    process: asyncio.subprocess.Process
    state: Literal["starting", "running", "idle", "error"]

    async def start(folder: Path, model: str) -> AgentSession
    async def send_prompt(text: str) -> None       # writes to stdin
    async def stream_output(callback) -> None       # reads stdout, calls callback per line
    async def stop() -> None                        # clean shutdown
```

**claw-code invocation:**
```bash
claw --permission-mode danger-full-access --model {model}
# Working directory: the selected project folder (so CLAUDE.md is discovered)
# stdin: user prompts
# stdout: agent output (stream line by line)
```

**Output parsing:**
- Each line from stdout → `{"type": "chunk", "content": line}` → WebSocket
- Special lines (tool calls, errors) parsed for visual differentiation
- `/compact` inserted automatically when session gets long (future feature)

### 3. `src/core/mcp.py` — MCP Manager

Responsibilities:
- Start Playwright MCP subprocess before agent session
- Inject MCP config into project's `.claw.json`
- Monitor MCP process health
- Kill MCP subprocesses on session end

```python
class MCPManager:
    playwright_process: asyncio.subprocess.Process | None

    async def start_playwright_mcp() -> bool       # returns True if started OK
    async def stop_all() -> None                   # kills all MCP subprocesses
    def is_playwright_available() -> bool          # checks npx + extension
    def get_claw_mcp_config() -> dict              # returns .claw.json mcpServers block
```

**Playwright MCP subprocess:**
```bash
npx @playwright/mcp@latest --extension --port 3333
```
Config injected into `.claw.json`:
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--extension"]
    }
  }
}
```

### 4. `app.py` — FastAPI Server

```python
# Routes
GET  /                    → serve index.html
GET  /static/{file}       → serve JS, CSS
WS   /ws                  → WebSocket (main channel)
POST /api/session/start   → { folder, model } → start agent
POST /api/session/stop    → stop current session
GET  /api/session/status  → { state, folder, model, session_id }
GET  /api/config          → { recent_folders, playwright_available, models }
POST /api/config/folder   → add folder to recents

# Startup
1. Load config (detect binaries, find port)
2. Start uvicorn
3. Open Chrome to localhost:{port}  ← webbrowser.open()
```

**WebSocket message protocol:**

```
Client → Server:
{ "type": "prompt", "content": "..." }          # user sends a message
{ "type": "ping" }                               # keepalive

Server → Client:
{ "type": "chunk",   "content": "..." }          # streaming agent output
{ "type": "done"                      }          # agent finished responding
{ "type": "system",  "content": "..." }          # app status messages
{ "type": "error",   "content": "..." }          # errors (show in chat)
{ "type": "state",   "state": "..." }            # session state change
```

### 5. `src/frontend/index.html` — The UI

**Layout:**
```
┌────────────────────────────────────────────┐
│  Claw Desktop         [folder picker]  [·] │  ← header
├────────────────────────────────────────────┤
│                                            │
│  [Agent]  Context loaded. Ready.           │
│                                            │
│                 [You]  Summarize my tasks  │
│                                            │
│  [Agent]  Sure! Reading Asana...           │
│           ▌  (streaming cursor)            │
│                                            │
├────────────────────────────────────────────┤
│  [Text input — Shift+Enter for newline  ]  │
│  [Send ↵]                                  │
└────────────────────────────────────────────┘
```

**Folder picker UX:**
```
Recent folders (chips):
[ ~/Projects/Asturias ] [ ~/Projects/Tarium ] [ + Browse ]

↓ (when "Browse" is clicked)
Enter folder path:  [_______________________] [✓]
```

**Visual design:**
- Dark background (#1a1a1a)
- Agent messages: dark gray bubble, left-aligned
- User messages: blue bubble, right-aligned
- System messages: centered, small, #666
- Monospace font for agent output (preserves formatting)
- Green dot = running, gray dot = idle, red dot = error

---

## Data Flow: Full Request Cycle

```
1. User types prompt → hits Enter
2. app.js → WebSocket.send({ type: "prompt", content: "..." })
3. FastAPI WS handler receives prompt
4. Checks session state = "running" → OK
5. Calls AgentSession.send_prompt(content) → writes to claw stdin
6. claw processes prompt, reads CLAUDE.md + _memory/, executes tools
7. claw writes output to stdout line by line
8. AgentManager.stream_output callback fires per line
9. Backend → WebSocket.send({ type: "chunk", content: line })
10. Frontend receives chunk → appends to current message bubble
11. User sees output in real time
12. claw sends terminal newline / completion signal
13. Backend → WebSocket.send({ type: "done" })
14. Frontend shows completion (cursor disappears)
```

---

## Setup Requirements (what user needs installed)

### Required
- Python 3.11+ (`python --version`)
- claw-code binary (build from source OR download release)
  - Mac: `cd claw-code/rust && cargo build --release`
  - Windows: same, output is `target/release/claw.exe`
- Chrome browser (for the UI + Playwright MCP Bridge extension)
- "Playwright MCP Bridge" Chrome extension (from Chrome Web Store)

### Required for browser automation
- Node.js 18+ + npm (`node --version`)
- `npx` available on PATH

### Python packages (requirements.txt)
```
fastapi>=0.110.0
uvicorn[standard]>=0.29.0
python-multipart>=0.0.9
aiofiles>=23.2.1
```

---

## File Creation Order (build sequence)

When building, create files in this order:

1. `requirements.txt`
2. `src/core/config.py` — detect environment, load config
3. `src/core/mcp.py` — MCP subprocess management
4. `src/core/agent.py` — claw subprocess management
5. `app.py` — FastAPI routes + WebSocket + startup
6. `src/frontend/styles.css` — dark theme
7. `src/frontend/app.js` — WebSocket client + UI logic
8. `src/frontend/index.html` — main UI (references JS + CSS)
9. `setup.md` — installation guide (Mac + Windows steps)

**Testing order:**
1. `python app.py` → browser opens at localhost:8080 ✓
2. Type folder path → validation shows green/yellow ✓
3. Send "hello" → claw starts, streams response ✓
4. Test on Mac first, then Windows VM
5. Test with both Claude (Anthropic key) and Grok (xAI key) ✓

---

## Phase 2 (after MVP validates)

- **Provider/model switcher** — dropdown in header, writes to session config
- **MCP status panel** — shows running MCPs, connect/disconnect controls
- **Session history** — list of past sessions, ability to resume
- **Context compact button** — sends `/compact` to claw when context gets long
- **Settings page** — configure API keys, default model, claw binary path
- **Packaging** — pyinstaller (Mac .app + Windows .exe) for true standalone distribution

---

## Why Not The Alternatives

| Alternative | Why Not |
|------------|---------|
| Direct LLM API calls (no claw) | Would rebuild tool execution, CLAUDE.md discovery, MCP lifecycle, session management from scratch — months of work |
| pywebview (native window) | Browser extension (Playwright MCP Bridge) needs to be in Chrome, not a webview. Would require two windows. |
| Electron | Backend would need to be Node.js, not Python. AD prefers Python. Heavier. |
| Bundled browser (puppeteer) | Loses AD's Chrome sessions/cookies — the whole point is "controlling browser as me" |
| React/Vue frontend | Unnecessary complexity for a single-view chat app. Vanilla JS is faster to build and maintain solo. |
