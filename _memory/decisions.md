# Architectural Decisions

---

## D1 — App Shell: Localhost in Chrome (not native window)
**Date:** Apr 5, 2026
**Decision:** MVP runs as a FastAPI server on localhost, auto-opens in Chrome. No pywebview or Electron.
**Reasoning:** Fastest to build. Chrome already has the Playwright MCP Bridge extension installed. Cross-platform without packaging overhead. Downside: looks like a web page, not a "real" app — acceptable for MVP.
**Revisit trigger:** When distributing to other users or when AD wants a system tray icon.

## D2 — Agent Engine: claw-code (not direct API calls)
**Date:** Apr 5, 2026
**Decision:** Use claw-code as the agent subprocess, not calling LLM APIs directly from Python.
**Reasoning:** claw-code already handles CLAUDE.md discovery, tool execution, MCP lifecycle, session persistence, and multi-provider routing. Rebuilding all of that in Python is months of work. claw-code gives us a complete agent harness for free.
**Risk:** claw-code is community-maintained, not Anthropic. If it breaks, we're blocked. Mitigate by wrapping in `AgentAdapter` class.

## D3 — Streaming: WebSocket (not SSE or polling)
**Date:** Apr 5, 2026
**Decision:** WebSocket for all real-time communication between Python backend and browser frontend.
**Reasoning:** Bidirectional (we need to send prompts AND receive streaming output). SSE is receive-only. Polling is ugly. WebSocket is native in every browser and FastAPI has first-class support.

## D4 — Frontend: Vanilla JS (no React/Vue)
**Date:** Apr 5, 2026
**Decision:** Plain HTML + JS for MVP. No frontend framework.
**Reasoning:** Reduces complexity, faster to build, easier to maintain solo. The UI is simple enough that a framework adds overhead without benefit. Alpine.js is the escape hatch if reactivity gets complex.
**Revisit trigger:** If we add multiple views (settings, MCP panel, session history) that need state management.

## D5 — Cross-Platform: pathlib.Path everywhere
**Date:** Apr 5, 2026
**Decision:** Every single file path uses `pathlib.Path`, never f-strings with `/`. This is non-negotiable.
**Reasoning:** Windows uses backslashes. Hardcoded `/` breaks on Windows. pathlib handles this transparently.

## D6 — MCP Management: Python-owned subprocesses
**Date:** Apr 5, 2026
**Decision:** Python backend spawns and kills all MCP server processes (Playwright MCP, etc.), not claw-code.
**Reasoning:** We need lifecycle control independent of claw-code. If the agent crashes, MCPs stay up for restart. Python has clean async subprocess management via asyncio.
**Alternative considered:** Let claw-code manage MCPs via its `.claw.json` config. Rejected because we lose control over startup order and cleanup.

## D7 — Session Model: One active session at a time (MVP)
**Date:** Apr 5, 2026
**Decision:** MVP supports exactly one agent session at a time. No concurrency.
**Reasoning:** AD is the only user. Multiple sessions adds complexity (session IDs, routing, cleanup) without benefit for MVP.
**Revisit trigger:** When distributing to a team.
