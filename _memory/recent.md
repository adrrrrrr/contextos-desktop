# Recent — Work Journal

**Sessions since last maintenance:** 2/5

---

## Session Log

### Apr 6, 2026 — Folder Picker UX Overhaul + Rename to ContextOS Desktop
- **Renamed** all "Claw Desktop" references → "ContextOS Desktop" (CLAUDE.md, identity.md, recent.md, .gitignore)
- **Studied claw-code** (github.com/ultraworkers/claw-code) patterns: auto-discovery, hierarchical config, safe file ops, workspace boundary checks
- **Redesigned folder picker modal** — replaced clunky Browse + "or type path" with unified drop zone:
  - Drag-and-drop folder support (File System Access API `getAsFileSystemHandle`)
  - Inline "browse" link within the drop zone (cleaner than a separate button)
  - Scanning progress indicator with file count updates (every 50 files)
  - Auto-detection of project types (Node.js, Python, Rust, Go, Docker, Context OS, etc.) — inspired by claw-code's `ProjectContext::discover_with_git`
  - Result card with name, path, badges (Context OS / file count), and clear button
  - Softer path resolution messaging ("Confirm the full path" instead of scary ⚠ warnings)
- **Extra folder modal** — added drop zone + browse button (was bare text input)
- **Project cards** — added delete button (visible on hover), with confirmation dialog
- **CSS** — all new components styled with existing design tokens (works in both dark + light themes)
- **Verified** — all HTML IDs, CSS classes, JS references consistent. No stale references.

### Apr 5, 2026 — MVP Built and Tested
- Built all 9 files in correct order per architecture spec
- `src/core/config.py` — platform detection, binary finding (shutil.which), config load/save, port finding, folder validation
- `src/core/agent.py` — AgentSession dataclass, run_prompt() using claw subprocess + --resume latest for session continuity, async on_chunk streaming, clean shutdown
- `src/core/mcp.py` — Playwright MCP subprocess management, .claw.json injection/removal, status reporting
- `app.py` — FastAPI + WebSocket, all REST endpoints, lifespan (startup/shutdown), browser auto-open
- `src/frontend/styles.css` — dark theme (#0f0f0f), chat bubbles (user=blue, agent=monospace, system=centered), streaming cursor animation
- `src/frontend/app.js` — WebSocket client, message handler, streaming renderer (appendChunk), folder picker with validation, auto-reconnect
- `src/frontend/index.html` — single-page chat UI with folder panel, recents chips, chat area, input textarea
- `SETUP.md` — Mac + Windows setup guide (claw-code build, API keys, Playwright extension)
- **Test results:** All endpoints return 200. Config loads correctly. Folder validation works. FastAPI imports clean.
- **Key fix:** Rewrote on_chunk as async callback (was incorrectly using run_in_executor + asyncio.run nested)
- **Blocking:** claw binary not found in this VM (expected — needs Rust build on user's machine)
- **Next:** User installs prerequisites per SETUP.md → tests end-to-end → then Phase 2 (provider switcher)

### Apr 5, 2026 — Project Genesis: Architecture Locked
- Context: AD wants to use Context OS when Cowork is offline, with other LLM providers + browser control
- **Decision:** Build ContextOS Desktop — Python FastAPI + HTML/JS frontend + claw-code + Playwright MCP
- **MVP scope locked:** Chat UI with streaming output + File/folder selector. Cross-platform Mac + Windows.
- **App shell:** Localhost in Chrome (no packaging for MVP). User runs `python app.py`, Chrome opens automatically.
- **Created:** Full Context OS project structure (CLAUDE.md, identity.md, decisions.md, history/, archive/, src/)
- **Created:** architecture-v1.md — full system design, API routes, WebSocket protocol, component breakdown
- **Next session:** Start building src/core/config.py → agent.py → app.py → frontend/index.html

---

## Blocking Items

1. 🔴 [ceo] **claw-code binary** — user must build from source (Rust toolchain needed) or wait for prebuilt releases. No binary distribution yet.
2. ✅ [ceo] **Project name** — Renamed to "ContextOS Desktop" (was "Claw Desktop").
3. 🟡 [ceo] **Playwright MCP Bridge extension** — user must install from Chrome Web Store. Document in setup guide.

---

## CEO Priorities

1. Build MVP: `python app.py` → browser opens → can chat with Context OS via claw-code
2. Validate Playwright browser MCP works with the agent (Discord/WhatsApp Web test)
3. Provider switcher (Phase 2 after MVP works)
