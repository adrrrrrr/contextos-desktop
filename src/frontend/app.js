// app.js — ContextOS Desktop
// Cowork-style UI: sessions sidebar, context panel (Progress / Working folders / Context), preview

'use strict';

/* ══════════════════════════════════════════════════════════════════════════════
   THEME
   ══════════════════════════════════════════════════════════════════════════════ */
const THEME_KEY = 'contextos-theme';

function getTheme()      { return localStorage.getItem(THEME_KEY) || 'dark'; }
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('app').setAttribute('data-theme', t);
  $('theme-icon-dark').style.display  = t === 'dark' ? '' : 'none';
  $('theme-icon-light').style.display = t === 'dark' ? 'none' : '';
  // Fix hljs stylesheet for light mode
  const hljsLink = document.getElementById('hljs-theme');
  if (hljsLink) {
    hljsLink.href = t === 'dark'
      ? 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark-dimmed.min.css'
      : 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css';
  }
  localStorage.setItem(THEME_KEY, t);
}
function toggleTheme() { applyTheme(getTheme() === 'dark' ? 'light' : 'dark'); }

/* ══════════════════════════════════════════════════════════════════════════════
   TOAST
   ══════════════════════════════════════════════════════════════════════════════ */
function toast(msg, type = 'info', ms = 3000) {
  let c = document.getElementById('toast-container');
  if (!c) { c = Object.assign(document.createElement('div'), {id:'toast-container'}); document.body.appendChild(c); }
  const el = Object.assign(document.createElement('div'), {className:`toast ${type}`, textContent:msg});
  c.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ══════════════════════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════════════════════ */
const S = {
  ws:               null,
  wsReady:          false,
  session:          null,
  providers:        [],
  selectedProv:     null,
  selectedModel:    '',
  pickedFolder:     null,      // {name, contextFiles, previewFiles, allFiles}
  manualFolder:     '',
  isRunning:        false,
  streamBubble:     null,
  streamRow:        null,      // the full .msg-row.ai for the current stream
  streamText:       '',
  turnCount:        0,
  tasksDone:        0,
  tasksTotal:       0,
  accessedFiles:    new Set(),
  createdFiles:     [],        // files created in this session [{path, content, written}]
  allKnownFiles:    [],        // union of picker files + created files
  previewCache:     {},        // path → content for ALL files (picker + created)
  _markdownTimer:   null,      // debounce handle for live markdown render
  pickedDirHandle:  null,      // directory handle for browser-picked write-back (File System Access API)
  sessionChatHTML:  {},        // session_id → chat innerHTML (for switching back)
  // ── Thinking block state ──────────────────────────────────────────────────
  thinkingBlock:    null,      // <details> element for current thinking block
  thinkingText:     '',        // accumulated thinking content
  thinkingStart:    0,         // Date.now() when thinking began
  _thinkingTimer:   null,      // setInterval handle for elapsed-time display
  hasMainContent:   false,     // whether real response text has started arriving
};

/* ══════════════════════════════════════════════════════════════════════════════
   DOM helpers
   ══════════════════════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);
const make = (tag, attrs = {}) => Object.assign(document.createElement(tag), attrs);

/* ══════════════════════════════════════════════════════════════════════════════
   STATUS
   ══════════════════════════════════════════════════════════════════════════════ */
function setStatus(state, text) {
  $('status-chip').setAttribute('data-state', state);
  $('status-text').textContent = text;
}

/* ══════════════════════════════════════════════════════════════════════════════
   WEBSOCKET
   ══════════════════════════════════════════════════════════════════════════════ */
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws    = new WebSocket(`${proto}//${location.host}/ws`);
  S.ws = ws;

  ws.onopen  = () => { S.wsReady = true;  setStatus('idle', 'Connected'); ws.send(JSON.stringify({type:'ping'})); };
  ws.onclose = () => { S.wsReady = false; S.ws = null; setStatus('error', 'Disconnected'); setTimeout(connectWS, 2000); };
  ws.onerror = () => setStatus('error', 'Connection error');
  // handleWSEnhanced is defined later in the file but is available at call-time (all code executed)
  ws.onmessage = e => { try { handleWSEnhanced(JSON.parse(e.data)); } catch {} };
}

function wsSend(obj) { if (S.ws && S.wsReady) S.ws.send(JSON.stringify(obj)); }

function handleWS(msg) {
  switch (msg.type) {
    case 'pong': break;

    case 'state':
      if (msg.session) {
        S.session = msg.session;
        updateHeaderForSession(msg.session);
        showContextPanel();
        refreshSessionsList();
      }
      if (msg.state === 'idle') {
        S.isRunning = false;
        setStatus('idle', S.session ? 'Ready' : 'Connected');
        $('stop-btn').classList.add('hidden');
        setInputEnabled(true);
        finalizeStream();
      } else if (msg.state === 'running') {
        S.isRunning = true;
        setStatus('running', 'Thinking…');
        $('stop-btn').classList.remove('hidden');
        setInputEnabled(false);
      }
      break;

    case 'agent_step':
      handleAgentStep(msg);
      break;

    case 'thinking_chunk':
      appendThinkingChunk(msg.content);
      break;

    case 'chunk':
      appendChunk(msg.content);
      break;

    case 'done':
      // state:idle follows immediately
      break;

    case 'file_event':
      handleFileEvent(msg);
      break;

    case 'system':
      appendSystemMsg(msg.content);
      break;

    case 'browser_write':
      handleBrowserWrite(msg);
      break;

    case 'session_restored':
      handleSessionRestored(msg);
      break;

    case 'error':
      appendSystemMsg('⚠ ' + msg.content, true);
      S.isRunning = false;
      setStatus('error', 'Error');
      $('stop-btn').classList.add('hidden');
      setInputEnabled(true);
      break;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   BROWSER WRITE-BACK — persist file writes for browser-picked sessions
   Uses File System Access API to write files to disk via the stored directory handle
   ══════════════════════════════════════════════════════════════════════════════ */
async function handleBrowserWrite(msg) {
  if (!S.pickedDirHandle) return;
  const { path, content } = msg;
  if (!path || content == null) return;
  try {
    const parts = path.split('/');
    let dirHandle = S.pickedDirHandle;
    // Navigate to subdirectories, creating as needed
    for (let i = 0; i < parts.length - 1; i++) {
      dirHandle = await dirHandle.getDirectoryHandle(parts[i], { create: true });
    }
    const fileName = parts[parts.length - 1];
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    // Update local cache
    S.previewCache[path] = content;
  } catch (e) {
    console.error('Browser write failed:', path, e);
    toast('Failed to save ' + path.split('/').pop() + ': ' + e.message, 'error');
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   SESSION RESTORE — re-render chat when switching to a previous session
   ══════════════════════════════════════════════════════════════════════════════ */
function handleSessionRestored(msg) {
  S.session = msg.session;
  hideProjectHome();
  updateHeaderForSession(msg.session);
  clearChat();
  resetActivityPanel();
  S.turnCount = 0;

  // Re-render all messages from the restored session
  const messages = msg.messages || [];
  messages.forEach(m => {
    if (m.role === 'user') {
      appendUserMsg(m.content);
      S.turnCount++;
    } else if (m.role === 'assistant' && m.content) {
      const bubble = appendAiMsgStart();
      // Strip XML file blocks from display
      const displayText = m.content.replace(/<create_file\s[^>]*>[\s\S]*?<\/create_file>/g, '').trim();
      renderMarkdown(bubble, displayText || m.content);
      bubble.classList.remove('typing-cursor');
      // Add copy button
      if (S.streamRow && m.content.trim()) addMsgCopyBtn(S.streamRow, displayText || m.content);
      S.streamBubble = null;
      S.streamText   = '';
    }
  });

  showContextPanel();
  refreshSessionsList();
  setInputEnabled(true);
  setStatus('idle', 'Ready');
  scrollToBottom(true);
}

/* ══════════════════════════════════════════════════════════════════════════════
   SESSION SWITCHING — save current chat and switch to another session
   ══════════════════════════════════════════════════════════════════════════════ */
function switchToSession(sessionId) {
  if (S.session && S.session.session_id === sessionId) return; // already active
  wsSend({type: 'switch_session', session_id: sessionId});
  setStatus('running', 'Switching…');
  setInputEnabled(false);
}

/* ══════════════════════════════════════════════════════════════════════════════
   AGENT STEP — Cowork-style agentic loading trace
   Shows each file being read, each decision, step-by-step in chat + progress panel
   ══════════════════════════════════════════════════════════════════════════════ */

let _loadingTraceEl  = null;   // the loading-trace block in the chat
let _loadingStepList = null;   // the <ul> inside it where file steps are appended
let _loadingTimer    = null;   // interval handle for elapsed time

function handleAgentStep(msg) {
  const {step} = msg;

  if (step === 'boot_start') {
    // Start a new loading trace block in the chat
    hideChatEmpty();
    const trace = make('div', {className: 'loading-trace'});
    trace.innerHTML = `
      <div class="lt-header">
        <span class="lt-spinner"></span>
        <span class="lt-title">Loading Context OS</span>
        <span class="lt-folder">${escText(msg.folder || '')}</span>
        <span class="lt-elapsed"></span>
      </div>
      <ul class="lt-steps"></ul>
      <div class="lt-footer hidden"></div>`;
    $('chat').appendChild(trace);
    _loadingTraceEl  = trace;
    _loadingStepList = trace.querySelector('.lt-steps');
    scrollToBottom(true);

    // Start elapsed timer
    const startTime = Date.now();
    _loadingTimer = setInterval(() => {
      if (!_loadingTraceEl) { clearInterval(_loadingTimer); return; }
      const sec = ((Date.now() - startTime) / 1000).toFixed(1);
      const el  = _loadingTraceEl.querySelector('.lt-elapsed');
      if (el) el.textContent = `${sec}s`;
    }, 200);

    // Also update the activity panel
    $('activity-empty').style.display = 'none';
    const actItem = make('div', {className: 'activity-item active-item', id: 'activity-loading'});
    actItem.innerHTML = `
      <div class="activity-turn">
        <span class="activity-turn-dot loading-dot"></span>
        Loading Context OS
      </div>
      <div class="activity-stream-preview">Reading project files…</div>`;
    $('activity-feed').appendChild(actItem);
  }

  else if (step === 'loading_file') {
    if (!_loadingStepList) return;
    const fname = (msg.file || '').split('/').pop();
    const label = msg.label || '';

    if (msg.status === 'reading') {
      // Add a new step row with a loading spinner
      const li = make('li', {className: 'lt-step reading'});
      li.dataset.file = msg.file;
      li.innerHTML = `
        <span class="lt-step-spinner"></span>
        <span class="lt-step-name">${escText(fname)}</span>
        <span class="lt-step-label">${escText(label)}</span>
        <span class="lt-step-meta"></span>`;
      _loadingStepList.appendChild(li);
      scrollToBottom();
    }
    else if (msg.status === 'done') {
      // Find the matching step and mark it done
      const li = _loadingStepList.querySelector(`li[data-file="${CSS.escape(msg.file)}"]`);
      if (li) {
        li.classList.remove('reading');
        li.classList.add('done');
        const spinner = li.querySelector('.lt-step-spinner');
        if (spinner) spinner.outerHTML = `<svg class="lt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        const meta = li.querySelector('.lt-step-meta');
        if (meta && msg.chars) {
          const kb = (msg.chars / 1024).toFixed(1);
          meta.textContent = `${kb} KB`;
        }
      }
      scrollToBottom();

      // Update activity panel
      const actPrev = document.querySelector('#activity-loading .activity-stream-preview');
      if (actPrev) actPrev.textContent = `Read ${fname}`;
    }
  }

  else if (step === 'context_ready') {
    clearInterval(_loadingTimer);
    _loadingTimer = null;
    const n = msg.files_loaded || 0;

    if (_loadingTraceEl) {
      // Swap spinner for check in header
      const spinner = _loadingTraceEl.querySelector('.lt-spinner');
      if (spinner) spinner.outerHTML = `<svg class="lt-header-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

      const title = _loadingTraceEl.querySelector('.lt-title');
      if (title) title.textContent = 'Context OS Loaded';

      // Show footer
      const footer = _loadingTraceEl.querySelector('.lt-footer');
      if (footer) {
        footer.classList.remove('hidden');
        footer.textContent = n > 0
          ? `${n} file${n>1?'s':''} loaded into system prompt — agent ready`
          : 'No Context OS files found — running without memory';
      }
      _loadingTraceEl.classList.add('complete');
      scrollToBottom();
    }

    // Update activity panel
    const actItem = $('activity-loading');
    if (actItem) {
      actItem.classList.remove('active-item');
      actItem.classList.add('done-item');
      const dot  = actItem.querySelector('.activity-turn-dot');
      if (dot)  dot.classList.remove('loading-dot');
      const prev = actItem.querySelector('.activity-stream-preview');
      if (prev) prev.textContent = n > 0 ? `${n} files loaded` : 'No context files found';
    }

    _loadingTraceEl  = null;
    _loadingStepList = null;
  }

  // ── Tool use: mid-conversation agentic file reads/writes ──────────────
  else if (step === 'tool_use') {
    const toolLabel = msg.label || msg.tool || 'Tool';
    const toolName  = msg.tool || '';

    if (msg.status === 'running') {
      // Create or reuse an inline tool-step block in the chat
      _ensureToolTraceBlock();
      const li = make('li', {className: 'lt-step reading'});
      li.dataset.toolCallId = toolName + '-' + Date.now();
      li.innerHTML = `
        <span class="lt-step-spinner"></span>
        <span class="lt-step-name">${escText(toolLabel)}</span>
        <span class="lt-step-label"></span>
        <span class="lt-step-meta"></span>`;
      _toolTraceStepList.appendChild(li);
      _lastToolStepEl = li;
      scrollToBottom();

      // Activity panel
      const actFeed = $('activity-feed');
      if (actFeed) {
        const step = make('div', {className: 'activity-file-step'});
        const icon = toolName === 'write_file'
          ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;flex-shrink:0;color:var(--accent)"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;flex-shrink:0;color:var(--accent)"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
        step.innerHTML = `${icon}
          <span style="font-size:11px;color:var(--text-secondary)">${escText(toolLabel)}</span>`;
        actFeed.appendChild(step);
        step.scrollIntoView({behavior:'smooth', block:'nearest'});
      }
    }
    else if (msg.status === 'done' || msg.status === 'error') {
      // Mark the last step as complete
      if (_lastToolStepEl) {
        _lastToolStepEl.classList.remove('reading');
        _lastToolStepEl.classList.add(msg.status === 'error' ? 'error' : 'done');
        const spinner = _lastToolStepEl.querySelector('.lt-step-spinner');
        if (spinner) {
          if (msg.status === 'error') {
            spinner.outerHTML = `<svg class="lt-check" style="color:var(--error)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
          } else {
            spinner.outerHTML = `<svg class="lt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
          }
        }
        const meta = _lastToolStepEl.querySelector('.lt-step-meta');
        if (meta && msg.chars) {
          const kb = (msg.chars / 1024).toFixed(1);
          meta.textContent = `${kb} KB`;
        }
        _lastToolStepEl = null;
      }
      scrollToBottom();
    }
  }
}

// ── Tool trace block management (inline in chat, similar to loading trace) ──
let _toolTraceEl       = null;
let _toolTraceStepList = null;
let _lastToolStepEl    = null;

function _ensureToolTraceBlock() {
  // Reuse existing block if it's the last element in chat (or close to it)
  // This groups consecutive tool calls into one card
  if (_toolTraceEl && _toolTraceEl.parentNode) {
    // Check if it's still recent (within the current AI response)
    return;
  }
  hideChatEmpty();
  const trace = make('div', {className: 'loading-trace tool-trace'});
  trace.innerHTML = `
    <div class="lt-header">
      <span class="lt-spinner"></span>
      <span class="lt-title">Using tools</span>
    </div>
    <ul class="lt-steps"></ul>`;
  // Insert before the current AI bubble row if possible
  const chat = $('chat');
  if (S.streamRow && S.streamRow.parentNode === chat) {
    chat.insertBefore(trace, S.streamRow);
  } else {
    chat.appendChild(trace);
  }
  _toolTraceEl       = trace;
  _toolTraceStepList = trace.querySelector('.lt-steps');
}

function _finalizeToolTrace() {
  if (!_toolTraceEl) return;
  const spinner = _toolTraceEl.querySelector('.lt-header .lt-spinner');
  if (spinner) spinner.outerHTML = `<svg class="lt-header-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const title = _toolTraceEl.querySelector('.lt-title');
  if (title) title.textContent = 'Tools complete';
  _toolTraceEl.classList.add('complete');
  _toolTraceEl       = null;
  _toolTraceStepList = null;
  _lastToolStepEl    = null;
}


/* ══════════════════════════════════════════════════════════════════════════════
   CHAT
   ══════════════════════════════════════════════════════════════════════════════ */
function hideChatEmpty() {
  // Legacy: empty state removed in favor of project home. No-op for compatibility.
}

function scrollToBottom(force = false) {
  const chat = $('chat');
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 200;
  if (force || nearBottom) chat.scrollTop = chat.scrollHeight;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/\n/g,'<br>');
}

function appendUserMsg(text) {
  hideChatEmpty();
  const row = make('div', {className: 'msg-row user'});
  row.innerHTML = `<div class="msg-avatar">U</div><div class="msg-bubble">${escHtml(text)}</div>`;
  $('chat').appendChild(row);
  scrollToBottom(true);
}

function appendAiMsgStart() {
  hideChatEmpty();
  const row    = make('div', {className: 'msg-row ai'});
  const bubble = make('div', {className: 'msg-bubble typing-cursor'});
  row.innerHTML = `<div class="msg-avatar">◈</div>`;
  row.appendChild(bubble);
  $('chat').appendChild(row);
  S.streamBubble = bubble;
  S.streamRow    = row;
  S.streamText   = '';
  scrollToBottom(true);
  return bubble;
}

/* ══════════════════════════════════════════════════════════════════════════════
   THINKING BLOCK — collapsible extended thinking (Gemini 2.5, o-series, etc.)
   ══════════════════════════════════════════════════════════════════════════════ */

const BRAIN_SVG = `<svg class="thinking-brain-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>`;
const CHEV_SVG  = `<svg class="thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const CHECK_SVG = `<svg class="thinking-done-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function appendThinkingChunk(chunk) {
  // Ensure an AI row + bubble exist (bubble stays empty while thinking)
  if (!S.streamRow) appendAiMsgStart();

  // Create the thinking block if it doesn't exist yet
  if (!S.thinkingBlock) {
    const details = make('details', {className: 'thinking-block'});
    details.setAttribute('open', '');  // expanded while thinking

    const summary = make('summary', {className: 'thinking-header'});
    summary.innerHTML = `
      <span class="thinking-spinner"></span>
      ${BRAIN_SVG}
      <span class="thinking-label">Thinking…</span>
      <span class="thinking-elapsed"></span>
      ${CHEV_SVG}`;
    const content = make('div', {className: 'thinking-content'});
    details.appendChild(summary);
    details.appendChild(content);

    // Insert BEFORE the main bubble so layout is: avatar → thinking → bubble
    S.streamRow.insertBefore(details, S.streamBubble);
    S.thinkingBlock = details;
    S.thinkingText  = '';
    S.thinkingStart = Date.now();
    S.hasMainContent = false;

    // Tick elapsed time every second
    S._thinkingTimer = setInterval(() => {
      if (!S.thinkingBlock) { clearInterval(S._thinkingTimer); return; }
      const sec     = Math.round((Date.now() - S.thinkingStart) / 1000);
      const elapsed = S.thinkingBlock.querySelector('.thinking-elapsed');
      if (elapsed) elapsed.textContent = `${sec}s`;
    }, 1000);

    // Update activity panel
    const preview = _activeActivityEl?.querySelector('.activity-stream-preview');
    if (preview) preview.textContent = 'Thinking deeply…';
  }

  S.thinkingText += chunk;
  const content = S.thinkingBlock.querySelector('.thinking-content');
  if (content) content.textContent = S.thinkingText;
  scrollToBottom();
}

function finalizeThinking() {
  if (!S.thinkingBlock) return;
  clearInterval(S._thinkingTimer);
  S._thinkingTimer = null;

  const sec     = Math.round((Date.now() - S.thinkingStart) / 1000);
  const spinner = S.thinkingBlock.querySelector('.thinking-spinner');
  const brain   = S.thinkingBlock.querySelector('.thinking-brain-icon');
  const label   = S.thinkingBlock.querySelector('.thinking-label');
  const elapsed = S.thinkingBlock.querySelector('.thinking-elapsed');

  if (spinner) spinner.remove();
  if (brain)   brain.style.display = 'none';
  // Insert check icon into summary
  const summary = S.thinkingBlock.querySelector('summary');
  if (summary) summary.insertAdjacentHTML('afterbegin', CHECK_SVG);
  if (label)   label.textContent = `Thought for ${sec}s`;
  if (elapsed) elapsed.textContent = '';

  // Auto-collapse — user can re-open if curious
  S.thinkingBlock.removeAttribute('open');
}

function resetThinkingState() {
  clearInterval(S._thinkingTimer);
  S._thinkingTimer  = null;
  S.thinkingBlock   = null;
  S.thinkingText    = '';
  S.thinkingStart   = 0;
  S.hasMainContent  = false;
}

function appendChunk(chunk) {
  if (!S.streamBubble) appendAiMsgStart();

  // First real text chunk — finalize thinking block so it auto-collapses
  if (S.thinkingBlock && !S.hasMainContent) {
    finalizeThinking();
    S.hasMainContent = true;
  }

  S.streamText += chunk;
  // Progressive markdown render: throttled to every 400ms
  S.streamBubble.classList.add('typing-cursor');
  clearTimeout(S._markdownTimer);
  S._markdownTimer = setTimeout(() => {
    if (S.streamBubble) {
      const hadCursor = S.streamBubble.classList.contains('typing-cursor');
      renderMarkdown(S.streamBubble, S.streamText);
      if (hadCursor) S.streamBubble.classList.add('typing-cursor');
    }
  }, 400);
  scrollToBottom();
  updateActiveActivityItem(S.streamText);
}

function finalizeStream() {
  // Finalize thinking block if response ended without any real text
  if (S.thinkingBlock && !S.hasMainContent) {
    finalizeThinking();
  }
  resetThinkingState();
  // Finalize any open tool trace block
  _finalizeToolTrace();

  if (!S.streamBubble) return;
  clearTimeout(S._markdownTimer);
  S.streamBubble.classList.remove('typing-cursor');
  // Strip <create_file> blocks from displayed text — they're ugly raw XML
  const displayText = S.streamText.replace(/<create_file\s[^>]*>[\s\S]*?<\/create_file>/g, '').trim();
  renderMarkdown(S.streamBubble, displayText || S.streamText);
  finalizeActivityItem(S.streamText);

  // Add message copy button below the AI bubble
  if (S.streamRow && S.streamText.trim()) {
    addMsgCopyBtn(S.streamRow, displayText || S.streamText);
  }

  S.streamBubble = null;
  // Keep S.streamRow so file pills can be attached by handleFileEvent
  S.streamText   = '';
}

function addMsgCopyBtn(row, text) {
  const COPY_SVG  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  const CHECK_SVG2= `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const actions = make('div', {className: 'msg-actions'});
  const btn = make('button', {className: 'msg-copy-btn', title: 'Copy response'});
  btn.innerHTML = COPY_SVG + '<span>Copy</span>';
  btn.addEventListener('click', () => {
    const plain = row.querySelector('.msg-bubble')?.innerText || text;
    navigator.clipboard.writeText(plain).then(() => {
      btn.innerHTML = CHECK_SVG2 + '<span>Copied!</span>';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = COPY_SVG + '<span>Copy</span>';
        btn.classList.remove('copied');
      }, 2000);
    });
  });
  actions.appendChild(btn);
  row.appendChild(actions);
}

function renderMarkdown(el, text) {
  if (!window.marked) { el.textContent = text; return; }
  try {
    el.innerHTML = marked.parse(text);
    if (window.hljs) el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
    // Attach copy buttons to every code block
    el.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.code-copy-btn')) return; // already attached
      const COPY_SVG  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      const btn = make('button', {className: 'code-copy-btn', title: 'Copy code'});
      btn.innerHTML = COPY_SVG;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const code = pre.querySelector('code');
        if (!code) return;
        navigator.clipboard.writeText(code.textContent).then(() => {
          btn.innerHTML = CHECK_SVG;
          btn.classList.add('copied');
          setTimeout(() => {
            btn.innerHTML = COPY_SVG;
            btn.classList.remove('copied');
          }, 1500);
        });
      });
      pre.appendChild(btn);
    });
  } catch { el.textContent = text; }
}

function appendSystemMsg(text, isError = false) {
  hideChatEmpty();
  const row    = make('div', {className: 'msg-row system'});
  const bubble = make('div', {className: 'msg-bubble'});
  bubble.textContent = text;
  if (isError) bubble.style.borderColor = 'rgba(224,82,82,0.3)';
  row.appendChild(bubble);
  $('chat').appendChild(row);
  scrollToBottom(true);
}

function setInputEnabled(on) {
  const inp = $('prompt-input'), btn = $('send-btn');
  inp.disabled = !on || !S.session;
  btn.disabled = !on || !S.session;
  if (on && S.session) inp.focus();
}

function sendPrompt() {
  const inp  = $('prompt-input');
  const text = inp.value.trim();
  if (!text || S.isRunning || !S.session) return;
  inp.value = '';
  inp.style.height = '';
  appendUserMsg(text);
  // Start activity item immediately
  S.turnCount++;
  startActivityItem(S.turnCount, text);
  appendAiMsgStart();
  wsSend({type:'prompt', content:text});
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 220) + 'px';
}

/* ══════════════════════════════════════════════════════════════════════════════
   FILE EVENTS — agent creates / modifies files
   ══════════════════════════════════════════════════════════════════════════════ */
function handleFileEvent(msg) {
  const { path, content, written } = msg;

  // Cache content for preview
  S.previewCache[path] = content;

  // Track in session created files
  S.createdFiles.push({ path, content, written });

  // Add to known files list
  if (!S.allKnownFiles.includes(path)) {
    S.allKnownFiles.push(path);
  }

  // Add file pill to the last AI message row
  const targetRow = S.streamRow || (() => {
    const rows = document.querySelectorAll('.msg-row.ai');
    return rows.length ? rows[rows.length - 1] : null;
  })();
  if (targetRow) addFilePillToRow(targetRow, path, content, written);

  // Add/update file in the Working folders tree
  upsertFileInTree(path, content, written ? 'modified' : 'draft');

  // ── Activity panel: show file creation as an agentic step ──
  const fname = path.split('/').pop();
  const actFeed = $('activity-feed');
  if (actFeed) {
    const step = make('div', {className: 'activity-file-step'});
    step.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;flex-shrink:0;color:var(--accent)"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span style="font-size:11px;color:var(--text-secondary)">${written ? 'Created' : 'Drafted'}</span>
      <span style="font-size:11px;font-weight:500;color:var(--text-primary);font-family:'SF Mono','Fira Code',monospace">${escText(fname)}</span>`;
    actFeed.appendChild(step);
    step.scrollIntoView({behavior:'smooth', block:'nearest'});
  }
}

function addFilePillToRow(row, filePath, content, written) {
  const filename = filePath.split('/').pop();
  const FILE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

  let pillsRow = row.querySelector('.msg-files-row');
  if (!pillsRow) {
    pillsRow = make('div', {className: 'msg-files-row'});
    row.appendChild(pillsRow);
  }

  const pill = make('button', {className: 'file-pill'});
  pill.innerHTML = `${FILE_SVG}<span class="fp-name">${escText(filename)}</span><span class="fp-badge">${written ? 'saved' : 'draft'}</span>`;
  pill.title = filePath;
  pill.addEventListener('click', () => {
    openFilePreview(filename, filePath, S.previewCache);
  });
  pillsRow.appendChild(pill);
  scrollToBottom();
}

function upsertFileInTree(filePath, content, badge) {
  // Store content for preview
  S.previewCache[filePath] = content;

  const tree = $('file-tree');
  const emptyEl = $('filetree-empty');
  if (emptyEl) emptyEl.style.display = 'none';

  // Find or create "Created by agent" group
  let group = tree.querySelector('.folder-group[data-agent-group]');
  if (!group) {
    group = make('div', {className: 'folder-group'});
    group.setAttribute('data-agent-group', '1');
    const DIR_ICON  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    const CHEV_ICON = `<svg class="folder-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;
    const hdr = make('div', {className: 'folder-group-header'});
    hdr.style.color = 'var(--accent)';
    hdr.innerHTML = `${DIR_ICON}<span>Created by agent</span>${CHEV_ICON}`;
    hdr.addEventListener('click', () => group.classList.toggle('collapsed'));
    group.appendChild(hdr);
    group.appendChild(make('div', {className: 'folder-group-files', id: 'agent-files-list'}));
    // Prepend to tree so it's visible immediately
    tree.insertBefore(group, tree.firstChild);
  }

  const filesList = group.querySelector('.folder-group-files');
  const filename  = filePath.split('/').pop();
  const FILE_SVG  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

  // Check if item already exists (update badge)
  const existing = filesList.querySelector(`[data-path="${CSS.escape(filePath)}"]`);
  if (existing) {
    const b = existing.querySelector('.file-item-badge');
    if (b) b.textContent = badge;
    return;
  }

  const item = make('div', {className: 'file-item previewable'});
  item.dataset.path = filePath;
  item.innerHTML = `${FILE_SVG}<span class="file-item-name">${escText(filename)}</span><span class="file-item-badge ${badge}">${badge}</span>`;
  item.addEventListener('click', () => openFilePreview(filename, filePath, S.previewCache));
  filesList.appendChild(item);

  // Auto-show the context panel
  showContextPanel();
}

/* ══════════════════════════════════════════════════════════════════════════════
   SESSIONS SIDEBAR
   ══════════════════════════════════════════════════════════════════════════════ */
async function refreshSessionsList() {
  try {
    const [sessData, projData] = await Promise.all([
      fetch('/api/sessions').then(r => r.json()),
      fetch('/api/projects').then(r => r.json()),
    ]);
    renderSessionsList(sessData.sessions || [], projData.projects || []);
  } catch {}
}

function renderSessionsList(sessions, projects) {
  const list  = $('sessions-list');
  const empty = $('sessions-empty');
  list.innerHTML = '';

  // ── Saved projects section ────────────────────────────────────────────
  if (projects && projects.length) {
    const projHdr = make('div', {className: 'sidebar-section-hdr'});
    projHdr.textContent = 'Projects';
    list.appendChild(projHdr);

    projects.forEach(p => {
      const name = p.name || p.folder.split('/').pop() || 'Project';
      const isActive = S.session && S.session.folder === p.folder;
      const efCount = (p.extra_folders || []).length;
      const folderShort = p.folder.includes('/') ? '…/' + p.folder.split('/').slice(-2).join('/') : p.folder;
      const item = make('div', {className: 'session-item project-item' + (isActive ? ' active' : '')});
      item.innerHTML = `
        <div class="session-item-top">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;flex-shrink:0;color:var(--accent)"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span class="session-folder">${escText(name)}</span>
          <span class="session-model">${escText(shortModel(p.model))}</span>
        </div>
        <div class="session-snippet" style="opacity:.5;font-size:10px">${escText(folderShort)}${efCount ? ` +${efCount}` : ''}</div>`;
      item.title = p.folder;
      item.addEventListener('click', () => {
        // Select this project and go to project home (don't auto-start session)
        _phSelected = p;
        _phExtraFolders = [...(p.extra_folders || [])];
        showProjectHome();
      });
      list.appendChild(item);
    });
  }

  // ── Active + recent sessions ──────────────────────────────────────────
  if (sessions.length) {
    const sessHdr = make('div', {className: 'sidebar-section-hdr'});
    sessHdr.textContent = 'Sessions';
    list.appendChild(sessHdr);

    sessions.forEach(s => {
      const item = make('div', {className: 'session-item' + (s.is_active ? ' active' : '')});
      item.innerHTML = `
        <div class="session-item-top">
          <span class="session-folder">${escText(s.folder_name)}</span>
          <span class="session-model">${escText(shortModel(s.model))}</span>
        </div>
        <div class="session-snippet">${escText(s.snippet || (s.is_active ? 'Active session' : 'No messages'))}</div>`;
      // Click to switch to this session (active or archived)
      item.style.cursor = 'pointer';
      if (s.is_active) {
        item.addEventListener('click', () => {
          // Go back to the active session's chat view
          hideProjectHome();
          setInputEnabled(true);
        });
      } else {
        item.addEventListener('click', () => switchToSession(s.session_id));
      }
      list.appendChild(item);
    });
  }

  if (!sessions.length && (!projects || !projects.length)) {
    empty.style.display = '';
  } else {
    empty.style.display = 'none';
  }
}

async function quickStartProject(proj) {
  // Quick-start a session from a saved project — select it and start
  _phSelected = proj;
  _phExtraFolders = [...(proj.extra_folders || [])];
  await phStartSession();
}

function shortModel(m) {
  if (!m) return '';
  const map = {'2.5-pro':'Pro','2.5-flash':'Flash','flash-lite':'Lite','sonnet':'Sonnet',
               'opus':'Opus','haiku':'Haiku','grok-3-mini':'Grok Mini','grok-3':'Grok 3',
               'o3':'o3','o4':'o4','gpt-4.1-mini':'GPT Mini','gpt-4.1':'GPT-4.1'};
  for (const [k,v] of Object.entries(map)) if (m.includes(k)) return v;
  return m.split('-').pop();
}

function escText(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ══════════════════════════════════════════════════════════════════════════════
   PROVIDERS / SETTINGS MODAL
   ══════════════════════════════════════════════════════════════════════════════ */
async function loadProviders() {
  try {
    const data = await (await fetch('/api/config')).json();
    S.providers = data.providers || [];
    renderRecents(data.recent_folders || []);
  } catch { S.providers = []; }
}

function openModal() {
  $('settings-overlay').classList.remove('hidden');
  renderProviderGrid();
  resetPicker();
}
function closeModal() { $('settings-overlay').classList.add('hidden'); }

function renderProviderGrid() {
  const grid = $('provider-grid');
  grid.innerHTML = '';
  if (!S.providers.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;font-size:12px;color:var(--text-muted);padding:4px 0">
      No API keys found. Set GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or XAI_API_KEY and restart.</div>`;
    return;
  }
  S.providers.forEach(p => {
    const btn = make('button', {className:'provider-btn'});
    btn.dataset.pid = p.id;
    btn.innerHTML = `<span>${escText(p.label)}</span><span class="provider-tag">${p.models.length} models</span>`;
    if (S.selectedProv && S.selectedProv.id === p.id) btn.classList.add('selected');
    btn.addEventListener('click', () => selectProvider(p));
    grid.appendChild(btn);
  });
  if (!S.selectedProv && S.providers.length) selectProvider(S.providers[0]);
}

function selectProvider(p) {
  S.selectedProv = p;
  document.querySelectorAll('.provider-btn').forEach(b => b.classList.toggle('selected', b.dataset.pid === p.id));
  $('model-section').style.display = '';

  // Populate with static models first, then try dynamic fetch for Gemini
  populateModelSelect(p.models, p.default_model);

  if (p.id === 'gemini') {
    // Async: fetch live models from Google API
    const key = p.api_key || '';
    fetch(`/api/gemini-models${key ? `?key=${encodeURIComponent(key)}` : ''}`)
      .then(r => r.json())
      .then(data => {
        if (data.models && data.models.length > 0) {
          populateModelSelect(data.models, data.models[0].id);
        }
      })
      .catch(() => {}); // keep static fallback
  }
  updateOpenBtn();
}

function populateModelSelect(models, defaultModel) {
  const sel = $('model-select');
  const prev = sel.value;
  sel.innerHTML = '';
  models.forEach(m => {
    const opt = make('option', {value: m.id, textContent: m.label + (m.tag ? ` — ${m.tag}` : '')});
    sel.appendChild(opt);
  });
  // Preserve previous selection if still available, otherwise use default
  sel.value = prev && [...sel.options].some(o => o.value === prev) ? prev : defaultModel;
  S.selectedModel = sel.value;
}

function renderRecents(folders) {
  const list = $('recents-list');
  list.innerHTML = '';
  if (!folders.length) { $('recents-section').style.display = 'none'; return; }
  $('recents-section').style.display = '';
  folders.slice(0, 8).forEach(f => {
    const parts = f.replace(/\\/g,'/').split('/');
    const name  = parts[parts.length - 1] || f;
    const item  = make('div', {className:'recent-item'});
    item.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;color:var(--text-muted)"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="recent-name">${escText(name)}</span>
      <span class="recent-path">${escText(f)}</span>`;
    item.addEventListener('click', () => {
      $('folder-input').value = f;
      S.manualFolder = f;
      validateManual(f);
    });
    list.appendChild(item);
  });
}

/* ── Folder picker (drag-drop + browse + manual path) ─────────────────────── */

const TEXT_EXTS = new Set(['.md','.txt','.html','.htm','.css','.js','.ts','.json',
  '.py','.yaml','.yml','.toml','.csv','.xml','.sh','.env','.ini','.cfg',
  '.gitignore','.tsx','.jsx','.rs','.go','.rb','.php','.sql']);
const SKIP_DIRS = new Set(['node_modules','__pycache__','.git','.venv','venv','dist','build','.next']);
const MAX_SIZE  = 300 * 1024; // 300KB

// Project type detection markers (inspired by claw-code's auto-discovery)
const PROJECT_MARKERS = [
  { files: ['package.json'],           label: 'Node.js' },
  { files: ['Cargo.toml'],             label: 'Rust' },
  { files: ['pyproject.toml','setup.py','requirements.txt'], label: 'Python' },
  { files: ['go.mod'],                 label: 'Go' },
  { files: ['Gemfile'],                label: 'Ruby' },
  { files: ['pom.xml','build.gradle'], label: 'Java' },
  { files: ['.git'],                   label: 'Git repo' },
  { files: ['CLAUDE.md'],              label: 'Context OS' },
  { files: ['docker-compose.yml','Dockerfile'], label: 'Docker' },
  { files: ['next.config.js','next.config.mjs'], label: 'Next.js' },
];

function resetPicker() {
  S.pickedFolder = null;
  S.manualFolder = '';
  S.pickedDirHandle = null;
  $('folder-input').value = '';
  $('folder-hint').textContent = '';
  $('folder-hint').className = 'folder-hint';
  // Reset dropzone to idle state
  const idle = $('dropzone-idle');
  const hover = $('dropzone-hover');
  const scanning = $('dropzone-scanning');
  const zone = $('folder-dropzone');
  if (idle) idle.classList.remove('hidden');
  if (hover) hover.classList.add('hidden');
  if (scanning) scanning.classList.add('hidden');
  if (zone) zone.classList.remove('has-result');
  // Hide result card + autodetect
  $('folder-picked').classList.add('hidden');
  const autodetect = $('folder-autodetect');
  if (autodetect) autodetect.classList.add('hidden');
  updateOpenBtn();
}

function showScanningState(detail) {
  const idle = $('dropzone-idle');
  const hover = $('dropzone-hover');
  const scanning = $('dropzone-scanning');
  if (idle) idle.classList.add('hidden');
  if (hover) hover.classList.add('hidden');
  if (scanning) scanning.classList.remove('hidden');
  $('scan-detail').textContent = detail || 'Detecting project type';
}

function hideScanningState() {
  const scanning = $('dropzone-scanning');
  if (scanning) scanning.classList.add('hidden');
}

function showFolderResult(name, resolvedPath, allFiles, contextFiles, detectedTypes) {
  const idle = $('dropzone-idle');
  const scanning = $('dropzone-scanning');
  const zone = $('folder-dropzone');
  if (idle) idle.classList.add('hidden');
  if (scanning) scanning.classList.add('hidden');
  if (zone) zone.classList.add('has-result');
  $('folder-picked').classList.remove('hidden');

  $('picked-name').textContent = name;
  const pathEl = $('picked-path');
  if (pathEl) pathEl.textContent = resolvedPath || name;

  const hasCtx = contextFiles && 'CLAUDE.md' in contextFiles;
  const ctxBadge = $('picked-context-badge');
  if (ctxBadge) ctxBadge.style.display = hasCtx ? '' : 'none';
  const filesBadge = $('picked-files-badge');
  if (filesBadge) filesBadge.textContent = `${allFiles.length} files`;

  // Show auto-detected project types
  const autodetect = $('folder-autodetect');
  if (autodetect && detectedTypes && detectedTypes.length) {
    autodetect.classList.remove('hidden');
    const items = $('autodetect-items');
    items.innerHTML = '';
    detectedTypes.forEach(t => {
      const chip = make('span', {className: 'autodetect-chip'});
      chip.textContent = t.label;
      items.appendChild(chip);
    });
  } else if (autodetect) {
    autodetect.classList.add('hidden');
  }
  updateOpenBtn();
}

function detectProjectTypes(allFiles) {
  const topLevel = new Set(allFiles.filter(f => !f.includes('/')));
  // Also check for hidden dirs like .git at top level
  const allTopNames = new Set(allFiles.map(f => f.split('/')[0]));
  const combined = new Set([...topLevel, ...allTopNames]);

  const found = [];
  for (const marker of PROJECT_MARKERS) {
    if (marker.files.some(f => combined.has(f))) {
      found.push(marker);
    }
  }
  return found;
}

async function handleBrowse() {
  if (!window.showDirectoryPicker) {
    toast('Browser folder picker not available — type the path below', 'info');
    $('folder-input').focus();
    return;
  }
  try {
    const dh = await window.showDirectoryPicker({mode:'readwrite'});
    S.pickedDirHandle = dh;
    showScanningState('Reading ' + dh.name + '…');
    await readDirHandle(dh, dh.name);
    await autoResolveFolder(dh.name);
  } catch (e) {
    if (e.name !== 'AbortError') {
      hideScanningState();
      const idle = $('dropzone-idle');
      if (idle) idle.classList.remove('hidden');
      toast('Could not open folder — try typing the path below', 'info');
      $('folder-input').focus();
    }
  }
}

async function readDirHandle(dh, folderName) {
  const contextFiles = {}, previewFiles = {}, allFiles = [];
  const CONTEXT_PATHS = new Set(['CLAUDE.md','_memory/identity.md','_memory/recent.md','_memory/history/SESSION-INDEX.md']);
  let scanned = 0;

  async function walk(handle, prefix) {
    try {
      for await (const [name, entry] of handle.entries()) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (entry.kind === 'directory') {
          if (!SKIP_DIRS.has(name) && !name.startsWith('.')) await walk(entry, rel);
        } else {
          allFiles.push(rel);
          scanned++;
          if (scanned % 50 === 0) {
            $('scan-detail').textContent = `${scanned} files found…`;
          }
          const ext = name.includes('.') ? '.'+name.split('.').pop().toLowerCase() : '';
          const isCtx = CONTEXT_PATHS.has(rel);
          if (isCtx || TEXT_EXTS.has(ext)) {
            try {
              const file = await entry.getFile();
              if (file.size < MAX_SIZE) {
                const content = await file.text();
                previewFiles[rel] = content;
                if (isCtx) contextFiles[rel] = content;
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  showScanningState('Scanning ' + folderName + '…');
  await walk(dh, '');

  const detected = detectProjectTypes(allFiles);
  S.pickedFolder = {name: folderName, contextFiles, previewFiles, allFiles, detected};
  showFolderResult(folderName, '', allFiles, contextFiles, detected);
}

async function autoResolveFolder(folderName) {
  try {
    const res = await fetch('/api/resolve-folder', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({name: folderName})
    });
    const data = await res.json();
    if (data.resolved) {
      $('folder-input').value = data.resolved;
      S.manualFolder = data.resolved;
      $('folder-hint').textContent = '✓ Path resolved';
      $('folder-hint').className = 'folder-hint valid';
      const pathEl = $('picked-path');
      if (pathEl) pathEl.textContent = data.resolved;
    } else {
      $('folder-hint').textContent = 'Confirm the full path so the agent can read/write files';
      $('folder-hint').className = 'folder-hint warn';
      $('folder-input').placeholder = '/Users/you/.../' + folderName;
      $('folder-input').focus();
    }
  } catch {
    $('folder-hint').textContent = 'Enter the full path to enable file access';
    $('folder-hint').className = 'folder-hint warn';
    $('folder-input').focus();
  }
  updateOpenBtn();
}

/* ── Drag-and-drop for folder dropzones ────────────────────────────────────── */

function initDropZone(dropzoneId, idleId, hoverId, onDrop) {
  const zone = $(dropzoneId);
  if (!zone) return;
  let dragCounter = 0;

  zone.addEventListener('dragenter', (e) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter++;
    $(idleId).classList.add('hidden');
    $(hoverId).classList.remove('hidden');
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', (e) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      $(hoverId).classList.add('hidden');
      if (!zone.classList.contains('has-result')) {
        $(idleId).classList.remove('hidden');
      }
      zone.classList.remove('dragover');
    }
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });

  zone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter = 0;
    zone.classList.remove('dragover');
    $(hoverId).classList.add('hidden');

    const items = [...e.dataTransfer.items];
    for (const item of items) {
      if (item.kind === 'file') {
        try {
          const handle = await item.getAsFileSystemHandle();
          if (handle && handle.kind === 'directory') {
            onDrop(handle);
            return;
          }
        } catch {}
        // Not a directory
        const file = item.getAsFile();
        if (file) {
          toast('Drop a folder, not a file', 'info');
          $(idleId).classList.remove('hidden');
          return;
        }
      }
    }
    toast('Could not read folder — try the browse button', 'info');
    $(idleId).classList.remove('hidden');
  });
}

/* ── Manual path validation (throttled) ────────────────────────────────────── */

let _vtimer = null;
function validateManual(path) {
  clearTimeout(_vtimer);
  if (!path.trim()) {
    $('folder-hint').textContent = '';
    $('folder-hint').className = 'folder-hint';
    updateOpenBtn();
    return;
  }
  $('folder-hint').textContent = 'Checking…';
  $('folder-hint').className = 'folder-hint';
  _vtimer = setTimeout(async () => {
    try {
      const d = await (await fetch('/api/validate-folder', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({folder:path})
      })).json();
      if (d.valid) {
        $('folder-hint').textContent = d.has_claude_md ? '✓ Context OS project detected' : '✓ Folder found';
        $('folder-hint').className = 'folder-hint valid';
      } else {
        $('folder-hint').textContent = d.error || 'Folder not found';
        $('folder-hint').className = 'folder-hint invalid';
      }
    } catch {
      $('folder-hint').textContent = 'Could not validate path';
      $('folder-hint').className = 'folder-hint invalid';
    }
    updateOpenBtn();
  }, 400);
}

function updateOpenBtn() {
  const hasPick   = !!S.pickedFolder;
  const hasManual = S.manualFolder.trim().length > 0 && $('folder-hint').classList.contains('valid');
  $('open-btn').disabled = !(S.selectedProv && (hasPick || hasManual));
}

async function saveProject() {
  // ── Save the project via REST, then show it on the project home ──
  if (!S.selectedProv) return;
  const model = $('model-select').value || S.selectedProv.default_model;
  let folderPath = S.manualFolder.trim();
  const folderName = S.pickedFolder ? S.pickedFolder.name : (folderPath.split('/').pop() || 'Project');

  // If no typed path but we have a browser pick, try to resolve on the server
  if (!folderPath && S.pickedFolder) {
    try {
      const res = await fetch('/api/resolve-folder', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({name: S.pickedFolder.name})
      });
      const data = await res.json();
      if (data.resolved) {
        folderPath = data.resolved;
      }
    } catch {}
  }

  // If still no path, store just the folder name — we'll re-browse when starting
  if (!folderPath) {
    folderPath = folderName;
  }

  // Save the project to the backend
  try {
    const res = await fetch('/api/projects', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        folder: folderPath,
        provider_id: S.selectedProv.id,
        model: model,
        name: folderName,
        extra_folders: _phExtraFolders || [],
      })
    });
    const data = await res.json();
    if (data.error) {
      toast('Could not save project: ' + data.error, 'error');
      return;
    }
  } catch (e) {
    toast('Failed to save project: ' + e.message, 'error');
    return;
  }

  toast('Project created!', 'info', 2000);
  closeModal();

  // Select the newly created project and show project home
  _phSelected = {
    folder: folderPath,
    provider_id: S.selectedProv.id,
    model: model,
    name: folderName,
    extra_folders: [...(_phExtraFolders || [])],
  };
  showProjectHome();
  refreshSessionsList();
}

function clearChat() {
  const chat = $('chat');
  chat.innerHTML = '';
  S.streamBubble = null; S.streamText = '';
  resetThinkingState();
}

/* ══════════════════════════════════════════════════════════════════════════════
   CONTEXT PANEL
   ══════════════════════════════════════════════════════════════════════════════ */
function showContextPanel() {
  $('context-panel').classList.remove('hidden');
}
function toggleContextPanel() {
  $('context-panel').classList.toggle('hidden');
}

// ── Collapsible sections ───────────────────────────────────────────────────
function initSectionToggles() {
  document.querySelectorAll('.cpanel-section-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      hdr.closest('.cpanel-section').classList.toggle('collapsed');
    });
  });
}

/* ── Session start entry in activity ─────────────────────────────────────── */
function addSessionStartEntry(folderName, model) {
  $('activity-empty').style.display = 'none';
  const el = make('div', {className:'activity-session-start'});
  el.innerHTML = `<span class="session-start-badge">NEW</span><span>${escText(folderName)}</span><span style="margin-left:auto;font-size:10px">${escText(shortModel(model))}</span>`;
  $('activity-feed').appendChild(el);
}

/* ── Activity items (one per turn) ───────────────────────────────────────── */
let _activeActivityEl = null;
let _activeActivityText = '';

function resetActivityPanel() {
  $('activity-feed').innerHTML = '';
  $('activity-empty').style.display = '';
  $('progress-counter').textContent = '';
  _activeActivityEl = null;
  _activeActivityText = '';
}

function startActivityItem(turnNum, userText) {
  $('activity-empty').style.display = 'none';
  const item = make('div', {className:'activity-item active-item'});
  item.id = `activity-turn-${turnNum}`;
  item.innerHTML = `
    <div class="activity-turn">
      <span class="activity-turn-dot"></span>
      Turn ${turnNum}
    </div>
    <div class="activity-snippet">${escText(userText.slice(0,60))}${userText.length>60?'…':''}</div>
    <div class="activity-stream-preview" style="font-size:11px;color:var(--text-muted);margin-top:3px;">Thinking…</div>`;
  $('activity-feed').appendChild(item);
  item.scrollIntoView({behavior:'smooth', block:'nearest'});
  _activeActivityEl   = item;
  _activeActivityText = '';
}

function updateActiveActivityItem(fullText) {
  if (!_activeActivityEl) return;
  const preview = _activeActivityEl.querySelector('.activity-stream-preview');
  if (preview) {
    // Show last meaningful line while streaming
    const lines = fullText.trim().split('\n').filter(l => l.trim());
    const last  = lines[lines.length - 1] || '';
    preview.textContent = last.length > 70 ? last.slice(0, 70) + '…' : last;
  }
}

function finalizeActivityItem(fullText) {
  if (!_activeActivityEl) return;
  _activeActivityEl.classList.remove('active-item');
  _activeActivityEl.classList.add('done-item');

  // Extract tasks from the response
  const tasks = extractTasks(fullText);
  const preview = _activeActivityEl.querySelector('.activity-stream-preview');

  if (tasks.length) {
    // Replace stream preview with task list
    if (preview) preview.remove();
    const tasksEl = make('div', {className:'activity-tasks'});
    tasks.forEach(t => {
      const task = make('div', {className:`activity-task${t.done?' done':''}`});
      task.innerHTML = `<span class="activity-task-check">${t.done ? '✓' : ''}</span><span class="activity-task-text">${escText(t.text.slice(0,60))}</span>`;
      tasksEl.appendChild(task);
    });
    _activeActivityEl.appendChild(tasksEl);
    // Update progress counter
    const done  = tasks.filter(t => t.done).length;
    const total = tasks.length;
    S.tasksDone  = done;
    S.tasksTotal = total;
    $('progress-counter').textContent = `${done} of ${total}`;
  } else {
    // Show snippet of response
    if (preview) {
      const lines = fullText.trim().split('\n').filter(l => l.trim());
      preview.textContent = lines[0] ? lines[0].slice(0, 80) : '';
      preview.style.color = 'var(--text-muted)';
    }
  }
  _activeActivityEl = null;
}

function extractTasks(text) {
  const tasks = [];
  const lines = text.split('\n');
  lines.forEach(line => {
    const t = line.trim();
    if (/^- \[x\]/i.test(t))   tasks.push({done:true,  text: t.replace(/^- \[x\]\s*/i,'')});
    else if (/^- \[ \]/.test(t)) tasks.push({done:false, text: t.replace(/^- \[ \]\s*/,'')});
    else if (/^\d+\.\s+✓/.test(t)) tasks.push({done:true,  text: t.replace(/^\d+\.\s+✓\s*/,'')});
  });
  return tasks;
}

/* ── Working folders (file tree) ─────────────────────────────────────────── */
function populateFileTree(allFiles, folderName, previewFiles) {
  const tree = $('file-tree');
  tree.innerHTML = '';  // destroys children, so recreate the empty hint

  // Recreate the empty hint node (destroyed by innerHTML clear above)
  const emptyHint = make('div', {className: 'cpanel-empty-hint', id: 'filetree-empty', textContent: 'No project loaded yet.'});
  emptyHint.style.display = allFiles.length ? 'none' : '';
  tree.appendChild(emptyHint);

  if (!allFiles.length) return;

  const PREVIEWABLE = new Set(['.md','.txt','.html','.htm','.css','.js','.ts','.json',
    '.py','.yaml','.yml','.toml','.csv','.xml','.sh','.tsx','.jsx']);
  const FILE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

  // Group by top-level dir (show as "folder group" like Cowork)
  const groups = {};
  allFiles.forEach(f => {
    const parts = f.split('/');
    const topDir = parts.length > 1 ? parts[0] : '__root__';
    if (!groups[topDir]) groups[topDir] = [];
    groups[topDir].push(f);
  });

  // Root-level files first
  if (groups['__root__']) {
    const g = createFolderGroup(folderName, groups['__root__'], '', PREVIEWABLE, FILE_ICON, previewFiles, true);
    tree.appendChild(g);
  }

  // Sub-directories
  Object.keys(groups).filter(k => k !== '__root__').sort().forEach(dirName => {
    const g = createFolderGroup(dirName, groups[dirName], dirName, PREVIEWABLE, FILE_ICON, previewFiles, false);
    tree.appendChild(g);
  });
}

function createFolderGroup(label, files, prefix, PREVIEWABLE, FILE_ICON, previewFiles, expanded) {
  const DIR_ICON  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  const CHEV_ICON = `<svg class="folder-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;

  const group = make('div', {className: 'folder-group' + (expanded ? '' : '')});
  const hdr   = make('div', {className: 'folder-group-header'});
  hdr.innerHTML = `${DIR_ICON}<span>${escText(label)}</span>${CHEV_ICON}`;
  hdr.addEventListener('click', () => group.classList.toggle('collapsed'));

  const filesList = make('div', {className: 'folder-group-files'});

  files.forEach(fullPath => {
    const parts   = fullPath.split('/');
    const name    = parts[parts.length - 1];
    const relPath = prefix ? fullPath.substring(prefix.length + 1) : fullPath;
    const ext     = name.includes('.') ? '.'+name.split('.').pop().toLowerCase() : '';
    const canPrev = PREVIEWABLE.has(ext);

    const item = make('div', {className:'file-item' + (canPrev ? ' previewable' : '')});
    item.dataset.depth = prefix ? Math.max(0, parts.length - 2) : 0;
    item.dataset.path  = fullPath;
    item.innerHTML = `${FILE_ICON}<span class="file-item-name">${escText(name)}</span>`;

    if (canPrev) {
      item.addEventListener('click', () => openFilePreview(name, fullPath, previewFiles));
    }
    filesList.appendChild(item);
  });

  group.appendChild(hdr);
  group.appendChild(filesList);
  return group;
}

/* ── Context section (loaded CLAUDE.md etc.) ────────────────────────────── */
function populateContextSection(loadedFiles, previewFiles) {
  const list = $('context-files-list');
  list.innerHTML = '';
  if (!loadedFiles || !loadedFiles.length) {
    list.innerHTML = '<div class="cpanel-empty-hint">No context files loaded (no CLAUDE.md found).</div>';
    return;
  }
  const FILE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  loadedFiles.forEach(f => {
    const name = f.split('/').pop();
    const item = make('div', {className:'context-file-item'});
    item.innerHTML = `${FILE_ICON}<span class="context-file-name">${escText(name)}</span><span class="context-file-sub">${escText(f)}</span>`;
    item.addEventListener('click', () => openFilePreview(name, f, previewFiles));
    list.appendChild(item);
  });
}

/* ── File preview ─────────────────────────────────────────────────────────── */
async function openFilePreview(filename, fullPath, _unused) {
  showContextPanel();

  let content = null;

  // 1. Check session preview cache (includes created files + picker files)
  if (S.previewCache[fullPath] !== undefined) {
    content = S.previewCache[fullPath];
  } else if (S.pickedFolder && S.pickedFolder.previewFiles && S.pickedFolder.previewFiles[fullPath] !== undefined) {
    content = S.pickedFolder.previewFiles[fullPath];
  } else {
    // 2. Ask the server (path-based sessions)
    try {
      const data = await (await fetch(`/api/file?path=${encodeURIComponent(fullPath)}`)).json();
      if (data.content != null) {
        content = data.content;
        S.previewCache[fullPath] = content; // cache it
      }
    } catch {}
  }

  if (content == null) {
    toast('Cannot read this file — it may be binary or too large', 'info');
    return;
  }

  // Mark as "viewed" in the file tree
  markFileViewed(fullPath);

  // Show preview pane
  $('preview-filename').textContent = filename;
  $('cpanel-sections').style.display = 'none';
  $('cpanel-preview').classList.remove('hidden');

  const contentEl = $('preview-content');
  const ext = (filename.split('.').pop() || '').toLowerCase();

  if (ext === 'html' || ext === 'htm') {
    contentEl.className = 'no-padding';
    contentEl.innerHTML = '';
    const iframe = make('iframe', {className:'preview-iframe', sandbox:'allow-scripts'});
    iframe.srcdoc = content;
    contentEl.appendChild(iframe);
  } else if (ext === 'md') {
    contentEl.className = '';
    if (window.marked) {
      contentEl.innerHTML = marked.parse(content);
      if (window.hljs) contentEl.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
    } else { contentEl.textContent = content; }
  } else {
    contentEl.className = '';
    const pre  = make('pre');
    const code = make('code');
    code.textContent = content;
    const langMap = {js:'javascript',ts:'typescript',py:'python',css:'css',json:'json',
      yaml:'yaml',yml:'yaml',sh:'bash',toml:'toml',xml:'xml',go:'go',rs:'rust',rb:'ruby'};
    if (langMap[ext]) code.className = `language-${langMap[ext]}`;
    if (window.hljs) hljs.highlightElement(code);
    pre.appendChild(code);
    contentEl.innerHTML = '';
    contentEl.appendChild(pre);
  }
}

function closePreview() {
  $('cpanel-preview').classList.add('hidden');
  $('cpanel-sections').style.display = '';
  $('preview-content').innerHTML = '';
  $('preview-content').className = '';
}

function markFileViewed(fullPath) {
  S.accessedFiles.add(fullPath);
  // Find the file item and add badge
  document.querySelectorAll('.file-item').forEach(item => {
    const name = item.querySelector('.file-item-name');
    if (name) {
      // Match by path stored on the item
      const existingBadge = item.querySelector('.file-item-badge');
      // We'll use data attribute to match
    }
  });
  // Update by re-checking all items
  document.querySelectorAll('.file-item[data-path]').forEach(item => {
    if (item.dataset.path === fullPath && !item.querySelector('.file-item-badge')) {
      const badge = make('span', {className:'file-item-badge viewed', textContent:'viewed'});
      item.appendChild(badge);
    }
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
   SESSION SETUP AFTER START
   ══════════════════════════════════════════════════════════════════════════════ */
function updateHeaderForSession(session) {
  $('hdr-folder').textContent = session.folder_name || 'Project';
  if (session.model) {
    $('hdr-sep').classList.remove('hidden');
    $('hdr-model').textContent = shortModel(session.model);
  }
}

function onSessionReady(session) {
  S.session = session;
  hideProjectHome();
  updateHeaderForSession(session);
  setInputEnabled(true);
  setStatus('idle', 'Ready');
  showContextPanel();
  addSessionStartEntry(session.folder_name, session.model);

  // Refresh sidebar (project was already saved by the modal or project home)
  refreshSessionsList();

  // Sync preview cache from picker (if available)
  if (S.pickedFolder) {
    S.allKnownFiles = [...(S.pickedFolder.allFiles || [])];
    S.previewCache  = {...(S.pickedFolder.previewFiles || {})};
    populateFileTree(S.pickedFolder.allFiles, session.folder_name, S.pickedFolder.previewFiles);
    populateContextSection(session.loaded_files, S.pickedFolder.previewFiles);
  } else {
    // Path-based: fetch from server
    fetchAndPopulateFileTree(session.folder_name, session.loaded_files);
  }

  // Send queued prompt from project home (if any)
  if (S._pendingPrompt) {
    const text = S._pendingPrompt;
    S._pendingPrompt = null;
    setTimeout(() => {
      appendUserMsg(text);
      S.turnCount++;
      startActivityItem(S.turnCount, text);
      appendAiMsgStart();
      wsSend({type:'prompt', content: text});
    }, 300);
  }
}

async function fetchAndPopulateFileTree(folderName, loadedFiles) {
  try {
    const data = await (await fetch('/api/files')).json();
    populateFileTree(data.files || [], folderName, null);
    populateContextSection(loadedFiles, null);
  } catch {}
}

/* ══════════════════════════════════════════════════════════════════════════════
   STOP GENERATION
   ══════════════════════════════════════════════════════════════════════════════ */
function stopGeneration() {
  if (S.ws) S.ws.close();
  if (S.streamBubble) {
    S.streamBubble.classList.remove('typing-cursor');
    renderMarkdown(S.streamBubble, S.streamText + '\n\n*[Stopped]*');
    if (_activeActivityEl) finalizeActivityItem(S.streamText + '\n\n[Stopped]');
    S.streamBubble = null; S.streamText = '';
  }
  S.isRunning = false;
  setStatus('idle', 'Stopped');
  $('stop-btn').classList.add('hidden');
  setInputEnabled(true);
}

/* ══════════════════════════════════════════════════════════════════════════════
   COPY PREVIEW CONTENT
   ══════════════════════════════════════════════════════════════════════════════ */
function copyPreview() {
  const text = $('preview-content').innerText;
  navigator.clipboard.writeText(text).then(() => toast('Copied!', 'success'));
}

/* ══════════════════════════════════════════════════════════════════════════════
   SCROLL BUTTON
   ══════════════════════════════════════════════════════════════════════════════ */
function updateScrollBtn() {
  const chat = $('chat');
  $('scroll-btn').classList.toggle('hidden', chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80);
}

/* ══════════════════════════════════════════════════════════════════════════════
   PROJECT HOME — Cowork-style landing page
   ══════════════════════════════════════════════════════════════════════════════ */
let _phProjects  = [];  // saved projects from /api/projects
let _phSelected  = null; // currently selected project {folder, provider_id, model, name}
let _phProviders = [];  // available providers (cached)
let _phOpenDD    = null; // currently open dropdown element (for closing on outside click)
let _phExtraFolders = []; // extra folder paths for the selected project

function showProjectHome() {
  $('project-home').classList.remove('hidden');
  $('chat').classList.add('hidden');
  $('input-area').classList.add('hidden');
  $('context-panel').classList.add('hidden');
  populateProjectHome();
}

function hideProjectHome() {
  $('project-home').classList.add('hidden');
  $('chat').classList.remove('hidden');
  $('input-area').classList.remove('hidden');
}

async function populateProjectHome() {
  // Fetch projects and providers fresh every time
  try {
    const [projData, provData] = await Promise.all([
      fetch('/api/projects').then(r => r.json()),
      fetch('/api/config').then(r => r.json()),
    ]);
    _phProjects  = projData.projects || [];
    _phProviders = provData.providers || [];
  } catch { _phProjects = []; _phProviders = []; }

  // Always re-derive _phSelected from fresh project data
  // If we had a previous selection, try to find it again in the fresh list
  if (_phSelected && _phSelected.folder) {
    const match = _phProjects.find(p => p.folder === _phSelected.folder);
    _phSelected = match || (_phProjects.length ? _phProjects[0] : null);
  } else {
    // No previous selection — pick the first (most recent) project
    _phSelected = _phProjects.length ? _phProjects[0] : null;
  }

  // Load extra folders from selected project
  _phExtraFolders = (_phSelected && _phSelected.extra_folders) ? [..._phSelected.extra_folders] : [];

  // ── Render project cards grid ────────────────────────────────────────
  renderProjectCards();

  // ── Update selectors ─────────────────────────────────────────────────
  if (_phSelected) {
    $('ph-title').textContent = _phSelected.name || _phSelected.folder.split('/').pop() || 'Project';
    $('ph-proj-label').textContent = (_phSelected.name || _phSelected.folder.split('/').pop()) +
      (_phProjects.length > 1 ? ` +${_phProjects.length - 1}` : '');

    const prov = _phProviders.find(p => p.id === _phSelected.provider_id);
    $('ph-model-label').textContent = shortModel(_phSelected.model) || (prov ? prov.label : 'Select model');
    $('ph-send').disabled = false;
  } else {
    $('ph-title').textContent = 'ContextOS Desktop';
    $('ph-proj-label').textContent = 'Select project';
    $('ph-model-label').textContent = 'Select model';
    $('ph-send').disabled = true;
  }

  // Render extra folder chips
  renderExtraFolderChips();

  // Populate recents from session history
  populatePhRecents();

  // Populate outputs from selected project files
  if (_phSelected && _phSelected.folder) {
    populatePhOutputs(_phSelected.folder);
  }
}

function renderProjectCards() {
  const section = $('ph-projects-section');
  const grid    = $('ph-projects-grid');
  grid.innerHTML = '';

  // Always show the section (even with 0 projects, we show the "+ New" card)
  section.style.display = '';

  // Render saved project cards
  _phProjects.forEach(p => {
    const name = p.name || p.folder.split('/').pop() || 'Project';
    const isSelected = _phSelected && _phSelected.folder === p.folder;
    const efCount = (p.extra_folders || []).length;

    const card = make('div', {className: 'ph-project-card' + (isSelected ? ' selected' : '')});
    card.innerHTML = `
      <div class="ph-pc-top">
        <div class="ph-pc-name">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          ${escText(name)}
        </div>
        <div class="ph-pc-actions">
          <button class="ph-pc-action-btn ph-pc-delete" title="Delete project" data-folder="${escText(p.folder)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
      <div class="ph-pc-meta">
        <span class="ph-pc-model">${escText(shortModel(p.model) || 'No model')}</span>
        ${efCount ? `<span>+${efCount} folder${efCount > 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="ph-pc-path">${escText(p.folder)}</div>`;

    // Click to select (but not on action buttons)
    card.addEventListener('click', (e) => {
      if (e.target.closest('.ph-pc-actions')) return;
      _phSelected = p;
      _phExtraFolders = [...(p.extra_folders || [])];
      renderProjectCards();
      $('ph-title').textContent = name;
      $('ph-proj-label').textContent = name + (_phProjects.length > 1 ? ` +${_phProjects.length - 1}` : '');
      const prov = _phProviders.find(pr => pr.id === p.provider_id);
      $('ph-model-label').textContent = shortModel(p.model) || (prov ? prov.label : 'Select model');
      $('ph-send').disabled = false;
      renderExtraFolderChips();
      if (p.folder) populatePhOutputs(p.folder);
    });

    // Delete button
    const delBtn = card.querySelector('.ph-pc-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Remove this project from the list? (Files on disk are not affected)')) return;
        try {
          await fetch('/api/projects/' + encodeURIComponent(p.folder), {method: 'DELETE'});
          if (_phSelected && _phSelected.folder === p.folder) _phSelected = null;
          populateProjectHome();
          toast('Project removed', 'info', 2000);
        } catch (err) {
          toast('Could not remove project: ' + err.message, 'error');
        }
      });
    }

    grid.appendChild(card);
  });

  // "+ New Project" card — always present
  const newCard = make('div', {className: 'ph-new-project-card'});
  newCard.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    <span>New Project</span>`;
  newCard.addEventListener('click', openModal);
  grid.appendChild(newCard);
}

async function populatePhOutputs(folder) {
  const section = $('ph-outputs-section');
  const track   = $('ph-outputs');
  track.innerHTML = '';

  try {
    // Validate folder exists, then fetch files
    const v = await (await fetch('/api/validate-folder', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({folder})
    })).json();
    if (!v.valid) { section.style.display = 'none'; return; }

    // Temporarily start a read-only peek at the folder files
    const filesData = await (await fetch('/api/files')).json();
    const files = (filesData.files || []).filter(f => {
      const ext = f.split('.').pop().toLowerCase();
      return ['md','txt','html','json','py','js','ts','yaml'].includes(ext);
    }).slice(0, 12);

    if (!files.length) { section.style.display = 'none'; return; }
    section.style.display = '';

    // Prioritize key files
    const priority = ['CLAUDE.md', '_memory/identity.md', '_memory/recent.md', '_memory/decisions.md'];
    const sorted = [...files].sort((a,b) => {
      const ai = priority.indexOf(a), bi = priority.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return 0;
    });

    for (const filePath of sorted.slice(0, 8)) {
      try {
        const data = await (await fetch(`/api/file?path=${encodeURIComponent(filePath)}`)).json();
        if (!data.content) continue;

        const card = make('div', {className: 'ph-output-card'});
        // Get first heading or first line
        const lines = data.content.split('\n').filter(l => l.trim());
        const heading = lines.find(l => l.startsWith('#')) || lines[0] || filePath;
        const preview = lines.filter(l => !l.startsWith('#')).slice(0, 6).join('\n');

        card.innerHTML = `
          <h4>${escText(heading.replace(/^#+\s*/, ''))}</h4>
          <div class="ph-card-preview">${escText(preview)}</div>`;
        card.title = filePath;
        card.addEventListener('click', () => {
          // Start a session and show this file
          phStartSession();
        });
        track.appendChild(card);
      } catch {}
    }
  } catch { section.style.display = 'none'; }
}

async function populatePhRecents() {
  const section = $('ph-recents-section');
  const list    = $('ph-recents');
  list.innerHTML = '';

  try {
    const data = await fetch('/api/sessions').then(r => r.json());
    const sessions = data.sessions || [];
    if (!sessions.length) { section.style.display = 'none'; return; }
    section.style.display = '';

    sessions.slice(0, 10).forEach(s => {
      const item = make('div', {className: 'ph-recent-item'});
      item.innerHTML = `
        <div class="ph-recent-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div class="ph-recent-body">
          <div class="ph-recent-title">${escText(s.snippet || s.folder_name || 'Session')}</div>
          <div class="ph-recent-snippet">${escText(s.folder_name)} · ${escText(shortModel(s.model))}</div>
        </div>
        <span class="ph-recent-time">${s.turn_count || 0} turns</span>`;
      item.addEventListener('click', () => {
        if (s.is_active) {
          // Restore the active session view
          hideProjectHome();
          setInputEnabled(true);
        } else {
          switchToSession(s.session_id);
          hideProjectHome();
        }
      });
      list.appendChild(item);
    });
  } catch { section.style.display = 'none'; }
}

/* ── Extra folders management ── */
function renderExtraFolderChips() {
  const container = $('ph-extra-folders');
  container.innerHTML = '';
  if (!_phExtraFolders.length) { container.style.display = 'none'; return; }
  container.style.display = 'flex';

  _phExtraFolders.forEach((folderPath, idx) => {
    const name = folderPath.replace(/\\/g, '/').split('/').pop() || folderPath;
    const chip = make('div', {className: 'ph-ef-chip'});
    chip.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span>${escText(name)}</span>`;
    const removeBtn = make('button', {className: 'ph-ef-remove', title: 'Remove folder'});
    removeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    removeBtn.addEventListener('click', () => removeExtraFolder(idx));
    chip.appendChild(removeBtn);
    container.appendChild(chip);
  });
}

function removeExtraFolder(idx) {
  _phExtraFolders.splice(idx, 1);
  renderExtraFolderChips();
  // Persist to server if we have a selected project
  if (_phSelected && _phSelected.folder) {
    _phSelected.extra_folders = [..._phExtraFolders];
    fetch('/api/projects/folders', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({folder: _phSelected.folder, extra_folders: _phExtraFolders})
    }).catch(() => {});
  }
}

function openExtraFolderModal() {
  $('extra-folder-overlay').classList.remove('hidden');
  $('ef-path-input').value = '';
  $('ef-hint').textContent = '';
  $('ef-add-btn').disabled = true;
  $('ef-path-input').focus();
}

function closeExtraFolderModal() {
  $('extra-folder-overlay').classList.add('hidden');
}

let _efValidTimer = null;
function validateExtraFolderInput(path) {
  clearTimeout(_efValidTimer);
  if (!path.trim()) { $('ef-hint').textContent = ''; $('ef-add-btn').disabled = true; return; }
  $('ef-hint').textContent = 'Checking…';
  _efValidTimer = setTimeout(async () => {
    try {
      const d = await (await fetch('/api/validate-folder', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({folder: path})
      })).json();
      if (d.valid) {
        $('ef-hint').textContent = '✓ Folder found';
        $('ef-hint').className = 'folder-hint valid';
        $('ef-add-btn').disabled = false;
      } else {
        $('ef-hint').textContent = d.error || 'Not found';
        $('ef-hint').className = 'folder-hint invalid';
        $('ef-add-btn').disabled = true;
      }
    } catch {
      $('ef-hint').textContent = 'Could not validate';
      $('ef-hint').className = 'folder-hint invalid';
      $('ef-add-btn').disabled = true;
    }
  }, 400);
}

function addExtraFolder() {
  const path = $('ef-path-input').value.trim();
  if (!path) return;
  // Avoid duplicates
  if (_phExtraFolders.includes(path)) {
    toast('Folder already added', 'info');
    closeExtraFolderModal();
    return;
  }
  _phExtraFolders.push(path);
  renderExtraFolderChips();
  closeExtraFolderModal();

  // Persist to server if we have a selected project
  if (_phSelected && _phSelected.folder) {
    _phSelected.extra_folders = [..._phExtraFolders];
    fetch('/api/projects/folders', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({folder: _phSelected.folder, extra_folders: _phExtraFolders})
    }).catch(() => {});
  }
}

/* ── Project dropdown ── */
function toggleProjectDropdown() {
  const dd = $('ph-project-dropdown');
  if (!dd.classList.contains('hidden')) { closeAllDropdowns(); return; }
  closeAllDropdowns();
  dd.innerHTML = '';

  _phProjects.forEach(p => {
    const name = p.name || p.folder.split('/').pop();
    const isSelected = _phSelected && _phSelected.folder === p.folder;
    const efCount = (p.extra_folders || []).length;
    const item = make('div', {className: 'ph-dd-item' + (isSelected ? ' selected' : '')});
    item.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span>${escText(name)}${efCount ? ` <small style="color:var(--text-muted)">+${efCount} folder${efCount > 1 ? 's' : ''}</small>` : ''}</span>
      <span class="ph-dd-item-sub">${escText(shortModel(p.model))}</span>`;
    item.addEventListener('click', () => {
      _phSelected = p;
      _phExtraFolders = [...(p.extra_folders || [])];
      closeAllDropdowns();
      populateProjectHome();
    });
    dd.appendChild(item);
  });

  if (!_phProjects.length) {
    dd.innerHTML = '<div class="ph-dd-item" style="color:var(--text-muted);cursor:default">No saved projects. Click + to add one.</div>';
  }

  dd.classList.remove('hidden');
  _phOpenDD = dd;
}

/* ── Model dropdown ── */
function toggleModelDropdown() {
  const dd = $('ph-model-dropdown');
  if (!dd.classList.contains('hidden')) { closeAllDropdowns(); return; }
  closeAllDropdowns();
  dd.innerHTML = '';

  if (!_phSelected) {
    dd.innerHTML = '<div class="ph-dd-item" style="color:var(--text-muted);cursor:default">Select a project first</div>';
    dd.classList.remove('hidden');
    _phOpenDD = dd;
    return;
  }

  // Show all providers and their models
  _phProviders.forEach(prov => {
    const hdr = make('div', {className: 'ph-dd-item', style: 'font-weight:600;font-size:11px;color:var(--text-muted);cursor:default;padding:4px 10px'});
    hdr.textContent = prov.label;
    dd.appendChild(hdr);

    prov.models.forEach(m => {
      const isSelected = _phSelected.provider_id === prov.id && _phSelected.model === m.id;
      const item = make('div', {className: 'ph-dd-item' + (isSelected ? ' selected' : '')});
      item.innerHTML = `<span>${escText(m.label)}</span>${m.tag ? `<span class="ph-dd-item-sub">${escText(m.tag)}</span>` : ''}`;
      item.addEventListener('click', () => {
        _phSelected = {..._phSelected, provider_id: prov.id, model: m.id};
        // Save to server
        fetch('/api/projects', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({folder: _phSelected.folder, provider_id: prov.id, model: m.id, name: _phSelected.name})
        }).catch(() => {});
        closeAllDropdowns();
        populateProjectHome();
      });
      dd.appendChild(item);
    });

    dd.appendChild(make('div', {className: 'ph-dd-divider'}));
  });

  dd.classList.remove('hidden');
  _phOpenDD = dd;
}

function closeAllDropdowns() {
  document.querySelectorAll('.ph-dropdown').forEach(d => d.classList.add('hidden'));
  _phOpenDD = null;
}

/* ── Ask for folder path (async HTML dialog, replaces window.prompt) ── */
function askFolderPath(folderName) {
  return new Promise(resolve => {
    // Create overlay
    const overlay = make('div', {className: 'path-ask-overlay'});
    overlay.innerHTML = `
      <div class="path-ask-modal">
        <div class="path-ask-title">Folder path needed</div>
        <div class="path-ask-desc">Could not auto-detect where "<b>${escText(folderName)}</b>" lives on disk.<br>Type the full path so sessions can read and write files.</div>
        <input type="text" class="path-ask-input" placeholder="/Users/you/Projects/${escText(folderName)}" autofocus />
        <div class="path-ask-btns">
          <button class="path-ask-cancel">Cancel</button>
          <button class="path-ask-ok">OK</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const inp = overlay.querySelector('.path-ask-input');
    const ok  = overlay.querySelector('.path-ask-ok');
    const cancel = overlay.querySelector('.path-ask-cancel');
    const close = (val) => { overlay.remove(); resolve(val); };
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', () => {
      const v = inp.value.trim();
      if (v) close(v); else inp.focus();
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); ok.click(); }
      if (e.key === 'Escape') close(null);
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
    setTimeout(() => inp.focus(), 50);
  });
}

/* ── Start session from project home ── */
async function phStartSession(initialPrompt) {
  if (!_phSelected) { openModal(); return; }

  const prov = _phProviders.find(p => p.id === _phSelected.provider_id);
  if (!prov) { toast('Provider not available — configure in settings', 'info'); openModal(); return; }

  let folderPath = _phSelected.folder;
  const isBareName = folderPath && !folderPath.includes('/') && !folderPath.includes('\\');

  // If folder is just a name (no real path), resolve via server
  if (isBareName) {
    const oldFolder = folderPath; // bare name for cleanup
    try {
      const res = await fetch('/api/resolve-folder', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({name: folderPath})
      });
      const data = await res.json();
      if (data.resolved) {
        folderPath = data.resolved;
        _phSelected.folder = folderPath;
        // Delete old bare-name project, persist with real path
        try {
          await fetch('/api/projects?folder=' + encodeURIComponent(oldFolder), {method: 'DELETE'});
          await fetch('/api/projects', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
              folder: folderPath, provider_id: _phSelected.provider_id,
              model: _phSelected.model, name: _phSelected.name,
              extra_folders: _phExtraFolders || [],
            })
          });
          refreshSessionsList();
        } catch {}
      } else {
        // Resolve failed — show inline path input dialog
        const oldFolder = folderPath; // bare name
        const userPath = await askFolderPath(folderPath);
        if (!userPath) return; // cancelled
        folderPath = userPath;
        _phSelected.folder = folderPath;
        // Delete old bare-name project, then persist with resolved path
        try {
          await fetch('/api/projects?folder=' + encodeURIComponent(oldFolder), {method: 'DELETE'});
          await fetch('/api/projects', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
              folder: folderPath, provider_id: _phSelected.provider_id,
              model: _phSelected.model, name: _phSelected.name,
              extra_folders: _phExtraFolders || [],
            })
          });
          refreshSessionsList();
        } catch {}
      }
    } catch (e) {
      toast('Failed to resolve folder: ' + e.message, 'error');
      return;
    }
  }

  hideProjectHome();
  clearChat();
  resetActivityPanel();
  S.turnCount = 0; S.tasksDone = 0; S.tasksTotal = 0;
  S.accessedFiles.clear();
  S.createdFiles = [];
  S.allKnownFiles = [];
  S.previewCache = {};
  S.streamRow = null;
  S.pickedFolder = null;
  S.pickedDirHandle = null;

  const startPayload = {
    type: 'start',
    folder: folderPath,
    folder_name: _phSelected.name || '',
    provider_id: _phSelected.provider_id,
    model: _phSelected.model || prov.default_model,
    api_key: prov.api_key || '',
  };
  if (_phExtraFolders.length) {
    startPayload.extra_folders = _phExtraFolders;
  }
  wsSend(startPayload);
  setStatus('running', 'Starting…');
  setInputEnabled(false);

  // If there's an initial prompt, queue it after session starts
  if (initialPrompt) {
    S._pendingPrompt = initialPrompt;
  }
}

function phSendPrompt() {
  const inp  = $('ph-prompt');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  phStartSession(text);
}

/* ── Output card navigation ── */
function phScrollOutputs(dir) {
  const track = $('ph-outputs');
  track.scrollBy({left: dir * 220, behavior: 'smooth'});
}

/* ══════════════════════════════════════════════════════════════════════════════
   OVERRIDE handleWS: hook session state to fire onSessionReady
   ══════════════════════════════════════════════════════════════════════════════ */
// Patch the original handleWS to call onSessionReady on first idle with session
const _origHandleWS = handleWS;
// We enhance by intercepting state:idle with session present
const handleWSEnhanced = function(msg) {
  if (msg.type === 'state' && msg.session && msg.state === 'idle' && !S.session) {
    // First session establishment
    onSessionReady(msg.session);
  } else if (msg.type === 'state' && msg.session && msg.state === 'idle' && S.session &&
             msg.session.session_id !== S.session?.session_id) {
    // New session (different ID)
    onSessionReady(msg.session);
  }
  _origHandleWS(msg);
};

/* ══════════════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════════════ */
async function init() {
  applyTheme(getTheme());
  connectWS();   // uses handleWSEnhanced (defined above)
  await loadProviders();
  refreshSessionsList();
  initSectionToggles();

  // Check for existing active session — if none, show project home
  let hasActive = false;
  try {
    const data = await (await fetch('/api/session/status')).json();
    if (data.active) {
      hasActive = true;
      onSessionReady(data);
      fetchAndPopulateFileTree(data.folder_name, data.loaded_files);
    }
  } catch {}

  if (!hasActive) {
    showProjectHome();
  }

  // ── Bind events ───────────────────────────────────────────────────────────

  $('theme-toggle').addEventListener('click', toggleTheme);
  $('sidebar-toggle').addEventListener('click', () => $('sessions-sidebar').classList.toggle('collapsed'));
  $('cpanel-toggle-btn').addEventListener('click', toggleContextPanel);

  $('settings-open-btn').addEventListener('click', openModal);
  $('new-session-btn').addEventListener('click', () => {
    S.session = null;
    showProjectHome();
  });
  $('settings-close').addEventListener('click', closeModal);
  $('settings-cancel').addEventListener('click', closeModal);
  $('settings-overlay').addEventListener('click', e => { if (e.target === $('settings-overlay')) closeModal(); });

  $('browse-btn').addEventListener('click', handleBrowse);
  $('folder-input').addEventListener('input', e => {
    S.manualFolder = e.target.value;
    // If user types a path, clear the browser-picked state to avoid confusion
    if (e.target.value.trim() && S.pickedFolder) {
      S.pickedFolder = null;
      $('folder-picked').classList.add('hidden');
      const autodetect = $('folder-autodetect');
      if (autodetect) autodetect.classList.add('hidden');
      const zone = $('folder-dropzone');
      if (zone) zone.classList.remove('has-result');
      const idle = $('dropzone-idle');
      if (idle) idle.classList.remove('hidden');
    }
    validateManual(e.target.value);
  });

  // Clear button on folder result card
  const clearBtn = $('folder-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', resetPicker);

  // Init main folder dropzone (drag-and-drop)
  initDropZone('folder-dropzone', 'dropzone-idle', 'dropzone-hover', async (dirHandle) => {
    S.pickedDirHandle = dirHandle;
    showScanningState('Reading ' + dirHandle.name + '…');
    await readDirHandle(dirHandle, dirHandle.name);
    await autoResolveFolder(dirHandle.name);
  });

  // Init extra folder dropzone
  initDropZone('ef-dropzone', 'ef-dropzone-idle', 'ef-dropzone-hover', async (dirHandle) => {
    // For extra folders, try to resolve the path and fill the input
    const name = dirHandle.name;
    try {
      const res = await fetch('/api/resolve-folder', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({name})
      });
      const data = await res.json();
      if (data.resolved) {
        $('ef-path-input').value = data.resolved;
        validateExtraFolderInput(data.resolved);
      } else {
        $('ef-path-input').value = name;
        $('ef-path-input').focus();
        $('ef-hint').textContent = 'Confirm the full path';
        $('ef-hint').className = 'folder-hint warn';
      }
    } catch {
      $('ef-path-input').value = name;
      $('ef-path-input').focus();
    }
  });

  // Extra folder browse button
  const efBrowse = $('ef-browse-btn');
  if (efBrowse) {
    efBrowse.addEventListener('click', async () => {
      if (!window.showDirectoryPicker) {
        toast('Browser folder picker not available — type the path', 'info');
        $('ef-path-input').focus();
        return;
      }
      try {
        const dh = await window.showDirectoryPicker({mode:'read'});
        try {
          const res = await fetch('/api/resolve-folder', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({name: dh.name})
          });
          const data = await res.json();
          if (data.resolved) {
            $('ef-path-input').value = data.resolved;
            validateExtraFolderInput(data.resolved);
          } else {
            $('ef-path-input').value = dh.name;
            $('ef-path-input').focus();
            $('ef-hint').textContent = 'Confirm the full path';
            $('ef-hint').className = 'folder-hint warn';
          }
        } catch {
          $('ef-path-input').value = dh.name;
          $('ef-path-input').focus();
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          $('ef-path-input').focus();
        }
      }
    });
  }

  $('model-select').addEventListener('change', e => { S.selectedModel = e.target.value; });
  $('open-btn').addEventListener('click', saveProject);

  $('send-btn').addEventListener('click', sendPrompt);
  $('prompt-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
  });
  $('prompt-input').addEventListener('input', e => autoGrow(e.target));

  $('chat').addEventListener('scroll', updateScrollBtn);
  $('scroll-btn').addEventListener('click', () => scrollToBottom(true));

  $('stop-btn').addEventListener('click', stopGeneration);
  $('preview-back-btn').addEventListener('click', closePreview);
  $('preview-copy-btn').addEventListener('click', copyPreview);

  // ── Project home events ──────────────────────────────────────────────────
  $('ph-project-btn').addEventListener('click', toggleProjectDropdown);
  $('ph-model-btn').addEventListener('click', toggleModelDropdown);
  $('ph-add-btn').addEventListener('click', openModal);
  $('ph-send').addEventListener('click', phSendPrompt);
  $('ph-prompt').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); phSendPrompt(); }
  });
  $('ph-prompt').addEventListener('input', e => {
    autoGrow(e.target);
    $('ph-send').disabled = !e.target.value.trim() || !_phSelected;
  });
  $('ph-out-prev').addEventListener('click', () => phScrollOutputs(-1));
  $('ph-out-next').addEventListener('click', () => phScrollOutputs(1));

  // ── Extra folder events ─────────────────────────────────────────────────
  $('ph-extra-folders-btn').addEventListener('click', openExtraFolderModal);
  $('ef-close').addEventListener('click', closeExtraFolderModal);
  $('ef-cancel').addEventListener('click', closeExtraFolderModal);
  $('extra-folder-overlay').addEventListener('click', e => { if (e.target === $('extra-folder-overlay')) closeExtraFolderModal(); });
  $('ef-path-input').addEventListener('input', e => validateExtraFolderInput(e.target.value));
  $('ef-path-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (!$('ef-add-btn').disabled) addExtraFolder(); }
  });
  $('ef-add-btn').addEventListener('click', addExtraFolder);

  // Close dropdowns on outside click
  document.addEventListener('click', e => {
    if (_phOpenDD && !e.target.closest('.ph-sel-wrap')) closeAllDropdowns();
  });

  document.addEventListener('keydown', e => {
    if ((e.metaKey||e.ctrlKey) && e.key === 'b') { e.preventDefault(); $('sessions-sidebar').classList.toggle('collapsed'); }
    if (e.key === 'Escape') { closeModal(); closePreview(); closeAllDropdowns(); }
  });
}

document.addEventListener('DOMContentLoaded', init);
