# app.py — ContextOS Desktop: FastAPI + WebSocket streaming, browser auto-open
import asyncio
import json
import sys
import webbrowser
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, str(Path(__file__).parent))

from src.core.config      import (load_config, save_config, add_recent_folder, validate_folder,
                                   print_startup_info, AppConfig, upsert_project, get_projects, delete_project,
                                   resolve_folder_name)
from src.core.llm         import get_available_providers, get_provider_api_key, stream_completion, fetch_gemini_models
from src.core.conversation import (create_session, create_session_from_content, clear_session,
                                   get_active, get_history, switch_to_session,
                                   parse_file_blocks, parse_file_reads, parse_present_files,
                                   execute_tool, AGENT_TOOLS, CONTEXT_OS_FILES)

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT     = Path(__file__).parent
FRONTEND = ROOT / "src" / "frontend"

cfg: AppConfig = AppConfig()

# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global cfg
    cfg = load_config()
    print_startup_info(cfg)

    async def _open():
        await asyncio.sleep(1.0)
        webbrowser.open(f"http://127.0.0.1:{cfg.port}")
    asyncio.create_task(_open())

    yield
    clear_session()
    print("ContextOS Desktop shut down.")

app = FastAPI(title="ContextOS Desktop", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")

# ── HTML ──────────────────────────────────────────────────────────────────────
@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")

# ── REST ──────────────────────────────────────────────────────────────────────
@app.get("/api/providers")
async def api_providers():
    """Available providers (those with env-var API keys set)."""
    return {"providers": get_available_providers()}

@app.get("/api/config")
async def api_config():
    return {
        "recent_folders": cfg.recent_folders,
        "providers":      get_available_providers(),
    }


@app.get("/api/gemini-models")
async def api_gemini_models(key: str = ""):
    """Dynamically fetch available Gemini models from the Google API."""
    import os
    api_key = key or os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        return {"models": [], "error": "No Gemini API key"}
    models = await fetch_gemini_models(api_key)
    return {"models": models}

@app.get("/api/session/status")
async def session_status():
    s = get_active()
    if not s:
        return {"active": False}
    return {
        "active":       True,
        "session_id":   s.session_id,
        "folder":       str(s.folder),
        "folder_name":  s.folder.name,
        "provider_id":  s.provider_id,
        "model":        s.model,
        "turn_count":   s.turn_count,
        "loaded_files": s.loaded_files,
    }

@app.post("/api/session/stop")
async def session_stop():
    clear_session()
    return {"ok": True}

@app.get("/api/sessions")
async def api_sessions():
    """Return active session + in-memory history (most-recent first)."""
    sessions = []
    # Always include the active session at the top
    active = get_active()
    if active:
        first_user = next((m["content"][:80] for m in active.messages if m["role"] == "user"), "Active session")
        sessions.append({
            "session_id":  active.session_id,
            "folder_name": active.folder.name,
            "provider_id": active.provider_id,
            "model":       active.model,
            "started_at":  datetime.utcnow().isoformat(),
            "turn_count":  active.turn_count,
            "snippet":     first_user,
            "is_active":   True,
        })
    # Archived sessions
    for s in get_history():
        sessions.append({
            "session_id":  s.session_id,
            "folder_name": s.folder_name,
            "provider_id": s.provider_id,
            "model":       s.model,
            "started_at":  s.started_at,
            "turn_count":  s.turn_count,
            "snippet":     s.snippet,
            "is_active":   False,
        })
    return {"sessions": sessions}


@app.get("/api/files")
async def api_files():
    """List all text files in the current session's folder (path-based sessions)."""
    session = get_active()
    if not session:
        return {"files": [], "folder_name": ""}
    folder = session.folder
    if not folder.is_dir():
        return {"files": [], "folder_name": folder.name}
    SKIP_DIRS  = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next'}
    TEXT_EXTS  = {'.md', '.txt', '.html', '.htm', '.css', '.js', '.ts', '.json',
                  '.py', '.yaml', '.yml', '.toml', '.csv', '.xml', '.sh', '.env',
                  '.ini', '.cfg', '.gitignore', '.tsx', '.jsx', '.rs', '.go'}
    files = []
    try:
        for path in sorted(folder.rglob("*")):
            if not path.is_file():
                continue
            parts = path.relative_to(folder).parts
            if any(p in SKIP_DIRS or p.startswith('.') for p in parts[:-1]):
                continue
            ext = path.suffix.lower()
            if ext in TEXT_EXTS or not path.suffix:
                files.append(str(path.relative_to(folder)))
    except Exception:
        pass
    return {"files": files, "folder_name": folder.name}


@app.get("/api/file")
async def api_file(path: str):
    """Read a file from the current session folder (security-checked)."""
    session = get_active()
    if not session:
        return {"content": None, "error": "No active session"}
    try:
        folder    = session.folder.resolve()
        file_path = (folder / path).resolve()
        # Security: must be within the session folder
        if not str(file_path).startswith(str(folder)):
            return {"content": None, "error": "Access denied"}
        if not file_path.is_file():
            return {"content": None, "error": "File not found"}
        if file_path.stat().st_size > 500_000:
            return {"content": None, "error": "File too large to preview"}
        content = file_path.read_text(encoding="utf-8", errors="replace")
        return {"content": content}
    except Exception as exc:
        return {"content": None, "error": str(exc)}

@app.post("/api/validate-folder")
async def api_validate(body: dict):
    return validate_folder(body.get("folder", ""))


# ── Projects (persistence) ───────────────────────────────────────────────
@app.get("/api/projects")
async def api_projects():
    """Return all saved projects, sorted by last_used."""
    return {"projects": get_projects(cfg)}


@app.post("/api/projects")
async def api_save_project(body: dict):
    """Save or update a project config."""
    folder      = body.get("folder", "").strip()
    provider_id = body.get("provider_id", "").strip()
    model       = body.get("model", "").strip()
    name        = body.get("name", "").strip()
    extra       = body.get("extra_folders", None)  # list of paths or None
    if not folder:
        return {"error": "folder is required"}
    proj = upsert_project(cfg, folder, provider_id, model, name, extra_folders=extra)
    return {"ok": True, "project": {"folder": proj.folder, "name": proj.name,
             "provider_id": proj.provider_id, "model": proj.model,
             "last_used": proj.last_used, "extra_folders": proj.extra_folders}}


@app.delete("/api/projects")
async def api_delete_project(folder: str = ""):
    deleted = delete_project(cfg, folder)
    return {"ok": deleted}


@app.post("/api/projects/folders")
async def api_update_project_folders(body: dict):
    """Add or update extra folders for a project."""
    folder = body.get("folder", "").strip()
    extra  = body.get("extra_folders", [])
    if not folder:
        return {"error": "folder is required"}
    proj = upsert_project(cfg, folder, "", "", extra_folders=extra)
    return {"ok": True, "project": {"folder": proj.folder, "name": proj.name,
             "extra_folders": proj.extra_folders}}

@app.post("/api/resolve-folder")
async def api_resolve_folder(body: dict):
    """Resolve a folder name to its real path on the filesystem."""
    name = body.get("name", "").strip()
    if not name:
        return {"resolved": None}
    path = resolve_folder_name(name, cfg.recent_folders)
    return {"resolved": path}


# ── WebSocket ─────────────────────────────────────────────────────────────────
async def ws_send(ws: WebSocket, msg: dict):
    try:
        await ws.send_text(json.dumps(msg))
    except Exception:
        pass

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()

    async def send(msg: dict):
        await ws_send(ws, msg)

    # Push current state on connect
    s = get_active()
    if s:
        await send({"type": "state", "state": "idle", "session": _session_info(s)})

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            t = msg.get("type")

            # ── ping ──────────────────────────────────────────────────────────
            if t == "ping":
                await send({"type": "pong"})

            # ── start session ─────────────────────────────────────────────────
            elif t == "start":
                folder_str    = msg.get("folder", "").strip()
                folder_name   = msg.get("folder_name", "").strip()
                context_files = msg.get("context_files")   # dict or None — sent by browser picker
                provider_id   = msg.get("provider_id", "")
                model         = msg.get("model", "")
                api_key_ovr   = msg.get("api_key", "")
                extra_strs    = msg.get("extra_folders") or []   # list of extra folder paths

                # Resolve folder: if only a name was given (browser picker), try to find the real path
                if not folder_str and folder_name:
                    resolved = resolve_folder_name(folder_name, cfg.recent_folders)
                    if resolved:
                        folder_str = resolved

                # Also resolve if folder_str looks like a bare name (no path separators)
                if folder_str and "/" not in folder_str and "\\" not in folder_str:
                    resolved = resolve_folder_name(folder_str, cfg.recent_folders)
                    if resolved:
                        folder_str = resolved

                # Validate provider
                api_key = get_provider_api_key(provider_id, api_key_ovr)
                if not api_key:
                    await send({"type": "error", "content": f"No API key for '{provider_id}'. Set the environment variable."}); continue

                clear_session()

                # ── Agentic loading trace: emit step-by-step file loading events ─
                #    This makes the UI show each file being read, like Cowork does.
                await send({"type": "agent_step", "step": "boot_start",
                            "folder": folder_name or folder_str.split("/")[-1] or "Project"})

                # Determine which context files will be loaded and emit per-file events
                FILE_LABELS = {
                    "CLAUDE.md":                         "Boot file",
                    "_memory/identity.md":               "Agent identity & rules",
                    "_memory/recent.md":                 "Work journal",
                    "_memory/history/SESSION-INDEX.md":  "Conversation memory",
                }

                if context_files is not None and not folder_str:
                    # Browser-picked, no resolved path: use content-based session
                    for rel_path in CONTEXT_OS_FILES:
                        if rel_path in context_files and context_files[rel_path].strip():
                            await send({"type": "agent_step", "step": "loading_file",
                                        "file": rel_path, "label": FILE_LABELS.get(rel_path, ""),
                                        "status": "reading"})
                            await asyncio.sleep(0.12)
                            chars = len(context_files[rel_path])
                            await send({"type": "agent_step", "step": "loading_file",
                                        "file": rel_path, "label": FILE_LABELS.get(rel_path, ""),
                                        "status": "done", "chars": chars})

                    name      = folder_name or "Project"
                    all_files = msg.get("all_files") or {}
                    session   = create_session_from_content(name, context_files, provider_id, model, api_key, all_files=all_files)
                elif context_files is not None and folder_str:
                    # Browser-picked BUT we resolved a real path — use path-based session (better!)
                    folder = Path(folder_str)
                    v = validate_folder(folder_str)
                    if v["valid"]:
                        for rel_path in CONTEXT_OS_FILES:
                            fp = folder / rel_path
                            if fp.is_file():
                                await send({"type": "agent_step", "step": "loading_file",
                                            "file": rel_path, "label": FILE_LABELS.get(rel_path, ""),
                                            "status": "reading"})
                                await asyncio.sleep(0.12)
                                try: chars = fp.stat().st_size
                                except: chars = 0
                                await send({"type": "agent_step", "step": "loading_file",
                                            "file": rel_path, "label": FILE_LABELS.get(rel_path, ""),
                                            "status": "done", "chars": chars})
                        extra_paths = [Path(e) for e in extra_strs if Path(e).is_dir()]
                        session = create_session(folder, provider_id, model, api_key, extra_folders=extra_paths)
                    else:
                        # Resolved path invalid, fall back to content-based
                        name = folder_name or "Project"
                        all_files = msg.get("all_files") or {}
                        session = create_session_from_content(name, context_files, provider_id, model, api_key, all_files=all_files)
                    add_recent_folder(cfg, folder_str)
                    upsert_project(cfg, folder_str, provider_id, model, folder_name or folder.name, extra_folders=extra_strs)
                else:
                    # Path-based: read from server filesystem
                    v = validate_folder(folder_str)
                    if not v["valid"]:
                        await send({"type": "error", "content": v["error"]}); continue
                    folder = Path(folder_str)

                    for rel_path in CONTEXT_OS_FILES:
                        fp = folder / rel_path
                        if fp.is_file():
                            await send({"type": "agent_step", "step": "loading_file",
                                        "file": rel_path, "label": FILE_LABELS.get(rel_path, ""),
                                        "status": "reading"})
                            await asyncio.sleep(0.12)
                            try:
                                chars = fp.stat().st_size
                            except Exception:
                                chars = 0
                            await send({"type": "agent_step", "step": "loading_file",
                                        "file": rel_path, "label": FILE_LABELS.get(rel_path, ""),
                                        "status": "done", "chars": chars})

                    extra_paths = [Path(e) for e in extra_strs if Path(e).is_dir()]
                    session = create_session(folder, provider_id, model, api_key, extra_folders=extra_paths)
                    add_recent_folder(cfg, folder_str)
                    upsert_project(cfg, folder_str, provider_id, model, extra_folders=extra_strs)

                # ── Final: context ready event ────────────────────────────────────
                n = len(session.loaded_files)
                await send({"type": "agent_step", "step": "context_ready",
                            "files_loaded": n,
                            "loaded_files": session.loaded_files})

                await send({"type": "state", "state": "idle", "session": _session_info(session)})

                if not session.loaded_files:
                    await send({"type": "system",
                                "content": "⚠ No CLAUDE.md found — agent running without Context OS memory"})

            # ── prompt ────────────────────────────────────────────────────────
            elif t == "prompt":
                content = (msg.get("content") or "").strip()
                if not content:
                    continue

                session = get_active()
                if not session:
                    await send({"type": "error", "content": "No active session. Select a folder first."}); continue

                await send({"type": "state", "state": "running"})
                session.add_user(content)

                # ── Agentic tool-use loop ────────────────────────────────────
                # The model may request tool calls (read_file, list_files, write_file).
                # We execute them, feed results back, and re-call the LLM — up to
                # MAX_TOOL_ROUNDS to prevent infinite loops.
                MAX_TOOL_ROUNDS = 10
                # Always provide tools — browser sessions use file_cache, path sessions use disk
                tools_for_llm = AGENT_TOOLS

                for round_idx in range(MAX_TOOL_ROUNDS + 1):
                    full_response = ""
                    full_thinking = ""
                    pending_tool_calls = None
                    had_error = False

                    try:
                        async for chunk_type, chunk_payload in stream_completion(
                            provider_id=session.provider_id,
                            model=session.model,
                            messages=session.get_llm_messages(),
                            api_key=session.api_key,
                            tools=tools_for_llm,
                        ):
                            if chunk_type == "thinking":
                                full_thinking += chunk_payload
                                await send({"type": "thinking_chunk", "content": chunk_payload})
                            elif chunk_type == "text":
                                full_response += chunk_payload
                                await send({"type": "chunk", "content": chunk_payload})
                            elif chunk_type == "tool_calls":
                                pending_tool_calls = chunk_payload  # list of {id, name, arguments}
                            elif chunk_type == "error":
                                await send({"type": "error", "content": chunk_payload})
                                had_error = True
                    except Exception as exc:
                        await send({"type": "error", "content": str(exc)})
                        had_error = True

                    # ── If model returned tool calls, execute them ────────────
                    if pending_tool_calls and not had_error:
                        # Add the assistant message with tool calls to history
                        session.add_assistant_with_tool_calls(
                            full_response or None,
                            pending_tool_calls,
                        )

                        for tc in pending_tool_calls:
                            tool_name = tc["name"]
                            try:
                                tool_args = json.loads(tc["arguments"])
                            except (json.JSONDecodeError, TypeError):
                                tool_args = {}

                            # Emit agent step: tool use starting
                            tool_label = _tool_label(tool_name, tool_args)
                            await send({"type": "agent_step", "step": "tool_use",
                                        "tool": tool_name, "label": tool_label,
                                        "status": "running", "args": tool_args})

                            # Execute the tool against the session folder
                            if session.has_real_folder:
                                result = execute_tool(session.folder, tool_name, tool_args,
                                                      extra_folders=session.extra_folders or None)
                            else:
                                # Browser session: use in-memory file_cache
                                result = _execute_browser_tool(session, tool_name, tool_args)
                                # For writes, send to browser for disk persistence
                                if tool_name == "write_file" and not result.startswith("Error"):
                                    await send({"type": "browser_write",
                                                "path": tool_args.get("path", ""),
                                                "content": tool_args.get("content", "")})

                            # Determine result summary for the UI
                            is_error = result.startswith("Error")
                            result_summary = result[:200] if len(result) > 200 else result

                            # Emit agent step: tool done
                            await send({"type": "agent_step", "step": "tool_use",
                                        "tool": tool_name, "label": tool_label,
                                        "status": "error" if is_error else "done",
                                        "result_summary": result_summary,
                                        "chars": len(result)})

                            # If it was a write_file, also emit a file_event
                            if tool_name == "write_file" and not is_error:
                                rel_path = tool_args.get("path", "")
                                await send({
                                    "type": "file_event",
                                    "action": "created",
                                    "path": rel_path,
                                    "content": tool_args.get("content", ""),
                                    "written": True,
                                    "error": None,
                                })

                            # Add tool result to conversation history
                            session.add_tool_result(tc["id"], result)

                        # Continue the loop — LLM will be called again with tool results
                        continue

                    # ── No tool calls from function calling — check for XML fallback ──
                    # Models (especially Gemini via OpenAI-compat) sometimes output
                    # XML tags instead of using function calling. Parse and execute them.
                    xml_writes = parse_file_blocks(full_response) if full_response else []
                    xml_reads  = parse_file_reads(full_response) if full_response else []
                    xml_presents = parse_present_files(full_response) if full_response else []

                    has_xml_actions = bool(xml_writes or xml_reads or xml_presents)

                    if has_xml_actions:
                        # Execute XML-based file writes
                        for rel_path, file_content in xml_writes:
                            await send({"type": "agent_step", "step": "tool_use",
                                        "tool": "write_file", "label": f"Writing {rel_path}",
                                        "status": "running", "args": {"path": rel_path}})
                            if session.has_real_folder:
                                result = execute_tool(session.folder, "write_file",
                                                      {"path": rel_path, "content": file_content})
                            else:
                                session.file_cache[rel_path] = file_content
                                result = f"OK — written {rel_path} ({len(file_content)} chars)"
                                await send({"type": "browser_write", "path": rel_path, "content": file_content})
                            is_error = result.startswith("Error")
                            await send({"type": "agent_step", "step": "tool_use",
                                        "tool": "write_file", "label": f"Writing {rel_path}",
                                        "status": "error" if is_error else "done",
                                        "chars": len(file_content)})
                            if not is_error:
                                await send({
                                    "type": "file_event", "action": "created",
                                    "path": rel_path, "content": file_content,
                                    "written": True, "error": None,
                                })

                        # Execute XML-based file reads and feed back into conversation
                        if xml_reads and round_idx < MAX_TOOL_ROUNDS:
                            read_results = []
                            for rel_path in xml_reads:
                                await send({"type": "agent_step", "step": "tool_use",
                                            "tool": "read_file", "label": f"Reading {rel_path}",
                                            "status": "running", "args": {"path": rel_path}})
                                if session.has_real_folder:
                                    result = execute_tool(session.folder, "read_file", {"path": rel_path})
                                else:
                                    result = session.file_cache.get(rel_path, f"Error: File not found: {rel_path}")
                                is_error = result.startswith("Error")
                                await send({"type": "agent_step", "step": "tool_use",
                                            "tool": "read_file", "label": f"Reading {rel_path}",
                                            "status": "error" if is_error else "done",
                                            "chars": len(result)})
                                read_results.append((rel_path, result))

                            # Feed read results back as a user message and re-call LLM
                            read_content = "\n\n".join(
                                f"### File: {rp}\n\n{rc}" for rp, rc in read_results
                            )
                            session.add_assistant(full_response)
                            session.add_user(
                                f"[System: The following files were read as requested]\n\n{read_content}"
                            )
                            continue  # Re-call LLM with the new file content

                        # Execute XML-based present-files (read + emit file_event for UI)
                        for rel_path in xml_presents:
                            if rel_path not in [w[0] for w in xml_writes]:
                                await send({"type": "agent_step", "step": "tool_use",
                                            "tool": "read_file", "label": f"Presenting {rel_path}",
                                            "status": "running", "args": {"path": rel_path}})
                                if session.has_real_folder:
                                    result = execute_tool(session.folder, "read_file", {"path": rel_path})
                                else:
                                    result = session.file_cache.get(rel_path, f"Error: File not found: {rel_path}")
                                is_error = result.startswith("Error")
                                await send({"type": "agent_step", "step": "tool_use",
                                            "tool": "read_file", "label": f"Presenting {rel_path}",
                                            "status": "error" if is_error else "done",
                                            "chars": len(result)})
                                if not is_error:
                                    await send({
                                        "type": "file_event", "action": "presented",
                                        "path": rel_path, "content": result,
                                        "written": False, "error": None,
                                    })

                    session.add_assistant(full_response)
                    break  # Done — exit the agentic loop

                await send({"type": "done"})
                await send({"type": "state", "state": "idle"})

            # ── switch session ────────────────────────────────────────────
            elif t == "switch_session":
                session_id = msg.get("session_id", "")
                session = switch_to_session(session_id)
                if session:
                    # Send filtered messages (only user/assistant with content)
                    filtered = [m for m in session.messages
                                if m["role"] in ("user", "assistant") and m.get("content")]
                    await send({"type": "session_restored",
                                "session": _session_info(session),
                                "messages": filtered})
                    await send({"type": "state", "state": "idle", "session": _session_info(session)})
                else:
                    await send({"type": "error", "content": "Session not found or expired"})

            else:
                await send({"type": "error", "content": f"Unknown type: {t}"})

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await ws_send(ws, {"type": "error", "content": str(exc)})
        except Exception:
            pass


def _execute_browser_tool(session, tool_name: str, tool_args: dict) -> str:
    """Execute tool calls for browser-picked sessions using the in-memory file cache."""
    if tool_name == "read_file":
        path = tool_args.get("path", "")
        if path in session.file_cache:
            return session.file_cache[path]
        return f"Error: File not found: {path}"
    elif tool_name == "list_files":
        directory = tool_args.get("directory", ".")
        items = set()
        for p in sorted(session.file_cache.keys()):
            if directory in (".", ""):
                top = p.split("/")[0]
                has_sub = "/" in p
                items.add(f"[{'dir' if has_sub else 'file'}] {top}")
            elif p.startswith(directory.rstrip("/") + "/"):
                rest = p[len(directory.rstrip("/")):].lstrip("/")
                top = rest.split("/")[0]
                has_sub = "/" in rest[len(top):]
                items.add(f"[{'dir' if has_sub else 'file'}] {top}")
        return "\n".join(sorted(items)) if items else "(empty directory)"
    elif tool_name == "write_file":
        path = tool_args.get("path", "")
        content = tool_args.get("content", "")
        session.file_cache[path] = content
        return f"OK — written {path} ({len(content)} chars)"
    return f"Unknown tool: {tool_name}"


def _tool_label(tool_name: str, tool_args: dict) -> str:
    """Human-readable label for a tool call, shown in the UI activity trace."""
    if tool_name == "read_file":
        return f"Reading {tool_args.get('path', 'file')}"
    elif tool_name == "list_files":
        d = tool_args.get("directory", ".")
        return f"Listing {d}" if d and d != "." else "Listing project root"
    elif tool_name == "write_file":
        return f"Writing {tool_args.get('path', 'file')}"
    return tool_name


def _session_info(s) -> dict:
    return {
        "session_id":    s.session_id,
        "folder":        str(s.folder),
        "folder_name":   s.folder.name,
        "provider_id":   s.provider_id,
        "model":         s.model,
        "loaded_files":  s.loaded_files,
        "extra_folders": [str(ef) for ef in (s.extra_folders or [])],
    }

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    boot = load_config()
    uvicorn.run("app:app", host="127.0.0.1", port=boot.port,
                reload=True, log_level="warning")
