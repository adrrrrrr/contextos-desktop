# ContextOS Desktop — Boot File

**Owner:** AD (Aderson de Rocha) | **Role:** Architect & CEO
**Project:** ContextOS Desktop — a cross-platform desktop app (Mac + Windows) that wraps claw-code + Playwright MCP into a Cowork-like UI. Context OS runs inside it, accessible with any LLM provider when Cowork is offline.
**Stack:** Python (FastAPI) + HTML/JS frontend + WebSocket streaming + claw-code (Rust CLI) + Playwright MCP
**Phase:** MVP — chat UI with streaming + folder picker. Provider switcher and MCP panel are Phase 2.

---

## Loading Protocol — Follow This Every Session

### Step 1: Orient (you just did this by reading this file)

### Step 2: Load core memory (ALWAYS)
```
READ → _memory/identity.md          (stack, rules, platform notes, anti-patterns)
READ → _memory/recent.md            (work journal, blocking items, what's in progress)
READ → _memory/history/SESSION-INDEX.md  (what was discussed in recent sessions)
```

### Step 2.5: Find relevant context
```
1. Does current task relate to a recent session? → Load that session file from history/
2. Check _memory/recent.md for pointers to relevant files
3. Check _skills/INDEX.md — does a skill apply?
4. Check archive/INDEX.md — reference material relevant?
5. Check _memory/decisions.md — past decision on this topic?
```

### Step 3: Load task-specific context
```
IF task involves the architecture or major design decisions:
  READ → archive/specs/architecture-v1.md

IF task involves agent/subprocess integration (how Python talks to claw-code):
  READ → _memory/identity.md → "Agent Integration" section

IF task involves the frontend (HTML/JS/WebSocket):
  READ → _memory/identity.md → "Frontend Rules" section

IF task involves cross-platform issues (Mac vs Windows):
  READ → _memory/identity.md → "Cross-Platform" section

IF task involves MCP server management (Playwright, etc.):
  READ → archive/analyses/browser-mcp-analysis-2026-04-05.md in Context OS/
  (path: ../Context OS/archive/analyses/browser-mcp-analysis-2026-04-05.md)

IF task involves drafting or sending a message as AD:
  READ → ../Context OS/_protocols/message-continuity.md
```

### Step 4: Execute the task

**Coding rules (permanent):**
- **First solve with claw-code, then add on if needed.** Before building any new feature from scratch, check how claw-code already implements it (read the repo, check archive analyses). Reuse its patterns, tools, and conventions. Only write custom code for what claw-code doesn't cover.
- Never write code without reading the relevant identity.md section first
- Every new file gets a one-line comment at the top explaining its role
- Test cross-platform paths with pathlib.Path, never string concatenation
- Always stream — never buffer and dump. Users see progress or they think it's broken.

### Step 5: Update memory after work
```
5a. Write session history → follow _memory/history/PROTOCOL.md (copy from Context OS)
5b. Update _memory/recent.md (add entry, increment maintenance counter)
5c. Update _memory/decisions.md if new architectural decision made
5d. Archive completed deliverables → archive/
5e. Update _skills/INDEX.md and archive/INDEX.md if files changed
```

---

## Folder Map

```
ContextOS Desktop/
├── CLAUDE.md                  ← YOU ARE HERE (boot file)
├── _memory/
│   ├── identity.md            ← Tech stack, platform rules, coding rules, anti-patterns
│   ├── recent.md              ← Rolling work journal
│   ├── decisions.md           ← Architectural decisions with reasoning
│   ├── people/                ← (empty for now — solo project)
│   └── history/
│       ├── SESSION-INDEX.md   ← Recent conversation memory
│       └── PROTOCOL.md        ← Session history management rules
├── .contextos-local/
│   ├── overrides.md           ← Project-specific rule overrides
│   └── version-synced         ← Context OS version tracking
├── _skills/
│   └── INDEX.md               ← Available skills for this project
├── docs/                      ← Active work / in-progress files
├── archive/
│   ├── INDEX.md               ← Completed work index
│   └── specs/
│       └── architecture-v1.md ← Full system architecture spec (locked)
├── src/                       ← Application source code
│   ├── core/
│   │   ├── agent.py           ← claw-code subprocess + streaming
│   │   ├── mcp.py             ← MCP server process management
│   │   └── config.py          ← Settings, paths, platform detection
│   └── frontend/
│       ├── index.html         ← Main app UI (single file)
│       ├── app.js             ← WebSocket client + UI logic
│       └── styles.css         ← Styles
├── app.py                     ← FastAPI server entry point
├── requirements.txt
└── messages-ready.md          ← Copy-paste outbound messages
```

---

## Critical Context

- **Parent OS:** Context OS lives at `../Context OS/` — read its analyses for browser MCP and claw-code research
- **claw-code repo:** https://github.com/ultraworkers/claw-code — the agent engine
- **Playwright MCP:** `@playwright/mcp` npm package + "Playwright MCP Bridge" Chrome extension
- **Target users (MVP):** AD only. Future: anyone who wants Context OS without Cowork.
- **Read-only on Context OS folder** — never edit files in `../Context OS/`, read only
