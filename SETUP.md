# Claw Desktop — Setup Guide

## What you need

| Requirement | macOS | Windows |
|-------------|-------|---------|
| Python 3.11+ | `brew install python` | python.org installer |
| Rust (for claw-code) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` | rustup.rs |
| Node.js 18+ | `brew install node` | nodejs.org installer |
| Chrome browser | — | — |

---

## Step 1 — Install Playwright MCP Bridge Chrome Extension

1. Open Chrome
2. Go to Chrome Web Store → search **"Playwright MCP Bridge"**
3. Click Install

This lets the agent control your actual Chrome tabs (with your logins, cookies, sessions).

---

## Step 2 — Build claw-code

```bash
git clone https://github.com/ultraworkers/claw-code
cd claw-code/rust
cargo build --release
```

**macOS:** binary at `claw-code/rust/target/release/claw`
**Windows:** binary at `claw-code\rust\target\release\claw.exe`

Add it to your PATH so `claw` is available from anywhere:

```bash
# macOS — add to ~/.zshrc or ~/.bashrc:
export PATH="$PATH:/path/to/claw-code/rust/target/release"

# Windows — add to System Environment Variables → Path
```

---

## Step 3 — Set your API key

For Claude (Anthropic):
```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # macOS/Linux
set ANTHROPIC_API_KEY=sk-ant-...        # Windows cmd
$env:ANTHROPIC_API_KEY="sk-ant-..."     # Windows PowerShell
```

For Grok (xAI) — optional:
```bash
export XAI_API_KEY="xai-..."
```

---

## Step 4 — Install Python dependencies

```bash
cd "Claw Desktop"
pip install -r requirements.txt       # macOS/Linux
pip install -r requirements.txt       # Windows (same)
```

---

## Step 5 — Run

```bash
python app.py
```

Chrome opens automatically at `http://localhost:8080`.

1. Paste the path to your Context OS project folder (e.g. `~/Projects/Asturias`)
2. Click **Open →**
3. Start chatting

---

## Troubleshooting

**`claw` not found:** Make sure claw-code's `target/release/` is on your PATH and you restarted your terminal.

**Port 8080 in use:** The app auto-detects the next free port (8081, 8082…). Check the console output for the actual URL.

**Playwright MCP not starting:** Make sure `npx` is on PATH (`npx --version` should work). Install Node.js if not.

**No CLAUDE.md warning:** You can still use the agent — it just won't have Context OS memory. Point to a project that has `CLAUDE.md`.

**Windows path issues:** Use forward slashes or backslashes — both work in the folder input.
