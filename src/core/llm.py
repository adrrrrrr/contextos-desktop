# llm.py — Multi-provider LLM abstraction. No claw-code dependency.
# Supports Gemini, OpenAI, xAI/Grok all via the openai-compatible API.
import os
from typing import AsyncGenerator

from openai import AsyncOpenAI

# ── Provider registry ─────────────────────────────────────────────────────────

PROVIDERS: dict[str, dict] = {
    "gemini": {
        "label":    "Gemini",
        "env_key":  "GEMINI_API_KEY",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        # Static fallback — replaced at runtime by fetch_gemini_models() if key is available
        "models": [
            {"id": "gemini-2.5-pro",          "label": "Gemini 2.5 Pro",        "tag": "Most capable"},
            {"id": "gemini-2.5-flash",         "label": "Gemini 2.5 Flash",      "tag": "Fast · Recommended"},
            {"id": "gemini-2.5-flash-lite",    "label": "Gemini 2.5 Flash Lite", "tag": "Efficient"},
            {"id": "gemini-2.0-flash",         "label": "Gemini 2.0 Flash",      "tag": ""},
            {"id": "gemini-2.0-flash-lite",    "label": "Gemini 2.0 Flash Lite", "tag": ""},
        ],
        "default_model": "gemini-2.5-flash",
    },
    "openai": {
        "label":    "OpenAI",
        "env_key":  "OPENAI_API_KEY",
        "base_url": "https://api.openai.com/v1",
        "models": [
            {"id": "gpt-4.1",       "label": "GPT-4.1",       "tag": "Latest"},
            {"id": "gpt-4.1-mini",  "label": "GPT-4.1 Mini",  "tag": "Fast"},
            {"id": "o3",            "label": "o3",             "tag": "Reasoning"},
            {"id": "o4-mini",       "label": "o4 Mini",        "tag": "Reasoning · Fast"},
        ],
        "default_model": "gpt-4.1",
    },
    "xai": {
        "label":    "xAI",
        "env_key":  "XAI_API_KEY",
        "base_url": "https://api.x.ai/v1",
        "models": [
            {"id": "grok-3",         "label": "Grok 3",         "tag": "Latest"},
            {"id": "grok-3-mini",    "label": "Grok 3 Mini",    "tag": "Fast"},
        ],
        "default_model": "grok-3",
    },
    "anthropic": {
        "label":    "Claude",
        "env_key":  "ANTHROPIC_API_KEY",
        "base_url": "https://api.anthropic.com/v1",
        "models": [
            {"id": "claude-opus-4-6",   "label": "Claude Opus 4",   "tag": "Most capable"},
            {"id": "claude-sonnet-4-6", "label": "Claude Sonnet 4", "tag": "Balanced"},
            {"id": "claude-haiku-4-5-20251001", "label": "Claude Haiku",  "tag": "Fast"},
        ],
        "default_model": "claude-sonnet-4-6",
    },
}


# ── Provider detection ────────────────────────────────────────────────────────

def get_available_providers() -> list[dict]:
    """
    Return providers that have an API key configured in the environment.
    Each entry: {id, label, models, default_model, api_key}
    """
    available = []
    for pid, cfg in PROVIDERS.items():
        key = os.environ.get(cfg["env_key"], "").strip()
        if key:
            available.append({
                "id":            pid,
                "label":         cfg["label"],
                "models":        cfg["models"],
                "default_model": cfg["default_model"],
                "api_key":       key,
            })
    return available


def get_provider_api_key(provider_id: str, override_key: str = "") -> str:
    """Get the API key for a provider — override takes precedence over env var."""
    if override_key:
        return override_key
    cfg = PROVIDERS.get(provider_id, {})
    return os.environ.get(cfg.get("env_key", ""), "").strip()


def get_provider_base_url(provider_id: str) -> str:
    return PROVIDERS.get(provider_id, {}).get("base_url", "")


# ── Streaming completion ──────────────────────────────────────────────────────

async def stream_completion(
    *,
    provider_id: str,
    model:       str,
    messages:    list[dict],   # [{role, content}, ...]
    api_key:     str,
    tools:       list[dict] | None = None,
) -> AsyncGenerator[tuple[str, object], None]:
    """
    Async generator that yields (chunk_type, payload) tuples:
      - ("thinking", text)       — reasoning / thought tokens (Gemini 2.5, o-series)
      - ("text", text)           — normal response content
      - ("tool_calls", [calls])  — model wants to call tools; list of {id, name, arguments}
      - ("error", text)          — error message to surface to the user

    Uses the OpenAI-compatible streaming API for all providers.
    Gemini 2.5 models emit thinking tokens on delta.reasoning_content
    (not delta.content), so both fields must be checked every chunk.
    Tool calls are accumulated across chunks and yielded once the stream ends.
    """
    cfg = PROVIDERS.get(provider_id)
    if not cfg:
        yield ("error", f"⚠ Unknown provider: {provider_id}")
        return

    if not api_key:
        yield ("error", f"⚠ No API key for provider '{cfg['label']}'. Set {cfg['env_key']} environment variable.")
        return

    client = AsyncOpenAI(
        api_key=api_key,
        base_url=cfg["base_url"],
    )

    # ── Gemini streaming bug workaround ────────────────────────────────────
    # Gemini's OpenAI-compat endpoint omits the required `index` field in
    # streaming tool_calls (delta.tool_calls[i].index is None), which crashes
    # the OpenAI Python SDK. Known bug since late 2024, still unfixed.
    # Workaround: when tools are provided for Gemini, use non-streaming for
    # the API call and simulate streaming by yielding the response in chunks.
    # For non-Gemini providers, standard streaming with tool accumulation works.
    is_gemini = provider_id == "gemini"
    use_streaming = not (is_gemini and tools)

    # Build create() kwargs
    create_kwargs: dict = dict(
        model=model,
        messages=messages,
        stream=use_streaming,
        max_tokens=8192,
        temperature=0.7,
    )
    if tools:
        create_kwargs["tools"] = tools
        create_kwargs["tool_choice"] = "auto"

    try:
        if not use_streaming:
            # ── Non-streaming path (Gemini with tools) ───────────────────
            # Make a single API call, then yield the response as if streamed.
            response = await client.chat.completions.create(**create_kwargs)
            if not response.choices:
                return

            choice = response.choices[0]
            msg = choice.message

            # Yield thinking if present (some models include it on non-stream too)
            thinking_text = getattr(msg, "reasoning_content", None)
            if thinking_text:
                yield ("thinking", thinking_text)

            # Yield text content in small chunks for progressive UI
            if msg.content:
                text = msg.content
                CHUNK_SIZE = 80
                for i in range(0, len(text), CHUNK_SIZE):
                    yield ("text", text[i:i+CHUNK_SIZE])

            # Yield tool calls if present
            if msg.tool_calls:
                calls = []
                for tc in msg.tool_calls:
                    calls.append({
                        "id": tc.id or f"call_{len(calls)}",
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    })
                yield ("tool_calls", calls)

        else:
            # ── Standard streaming path (OpenAI, xAI, Anthropic, Gemini without tools) ──
            stream = await client.chat.completions.create(**create_kwargs)

            # Accumulate tool call chunks across the stream.
            tool_call_accumulators: dict[int, dict] = {}

            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta

                # Thinking tokens — Gemini 2.5, OpenAI o-series, etc.
                thinking_text = getattr(delta, "reasoning_content", None)
                if thinking_text:
                    yield ("thinking", thinking_text)

                # Normal response tokens
                if delta.content:
                    yield ("text", delta.content)

                # Tool call chunks — accumulate by index
                # Guard against None index (Gemini bug) by defaulting to len()
                if delta.tool_calls:
                    for tc_delta in delta.tool_calls:
                        idx = tc_delta.index if tc_delta.index is not None else len(tool_call_accumulators)
                        if idx not in tool_call_accumulators:
                            tool_call_accumulators[idx] = {"id": "", "name": "", "arguments": ""}
                        acc = tool_call_accumulators[idx]
                        if tc_delta.id:
                            acc["id"] = tc_delta.id
                        if tc_delta.function:
                            if tc_delta.function.name:
                                acc["name"] = tc_delta.function.name
                            if tc_delta.function.arguments:
                                acc["arguments"] += tc_delta.function.arguments

            # After the stream ends: if we accumulated tool calls, yield them
            if tool_call_accumulators:
                calls = [tool_call_accumulators[i] for i in sorted(tool_call_accumulators)]
                yield ("tool_calls", calls)

    except Exception as exc:
        err = str(exc)
        # Make common errors friendlier
        if "401" in err or "403" in err or "API_KEY" in err.upper():
            yield ("error", f"\n\n⚠ **Auth error** — check your {cfg['label']} API key.")
        elif "429" in err:
            yield ("error", "\n\n⚠ **Rate limit hit** — wait a moment and try again.")
        elif "404" in err:
            yield ("error", f"\n\n⚠ **Model not found**: `{model}` — try a different model.")
        else:
            yield ("error", f"\n\n⚠ **Error**: {err}")


# ── Dynamic Gemini model discovery ───────────────────────────────────────────

async def fetch_gemini_models(api_key: str) -> list[dict]:
    """
    Query the Gemini REST API to get the current list of available chat models.
    Returns a sorted list of {id, label, tag} dicts — newest/best models first.
    Falls back to the static list if the API call fails.
    """
    try:
        import httpx
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": api_key, "pageSize": 100},
            )
            r.raise_for_status()
            raw = r.json().get("models", [])
    except Exception:
        return []   # caller uses static fallback

    SKIP = {"embedding", "aqa", "vision-", "text-", "code-"}
    CHAT_METHODS = {"generateContent", "streamGenerateContent"}
    SKIP_SUFFIXES = {"-001", "-002", "-003"}

    results = []
    for m in raw:
        name    = m.get("name", "")           # "models/gemini-2.5-pro"
        methods = set(m.get("supportedGenerationMethods", []))
        if not (methods & CHAT_METHODS):
            continue
        if "gemini" not in name:
            continue
        mid = name.removeprefix("models/")
        if any(s in mid for s in SKIP):
            continue
        if any(mid.endswith(s) for s in SKIP_SUFFIXES):
            continue
        label = m.get("displayName") or mid.replace("-", " ").title()
        results.append({"id": mid, "label": label, "tag": ""})

    if not results:
        return []

    # Annotate tags
    for item in results:
        mid = item["id"]
        if "pro" in mid and "lite" not in mid:
            item["tag"] = "Most capable"
        elif "flash" in mid and "lite" not in mid:
            item["tag"] = "Fast"
        elif "lite" in mid or "nano" in mid:
            item["tag"] = "Efficient"

    # Sort: highest version first, within same version pro > flash > lite
    def sort_key(item):
        mid   = item["id"]
        parts = mid.replace("gemini-", "").split("-")
        ver   = 0.0
        try:
            ver = float(parts[0])
        except (ValueError, IndexError):
            pass
        tier = 0 if "pro" in mid else (1 if "flash" in mid and "lite" not in mid else 2)
        # Prefer non-preview / non-exp
        is_preview = 1 if ("preview" in mid or "exp" in mid) else 0
        return (-ver, tier, is_preview, mid)

    results.sort(key=sort_key)

    # Mark the top flash as recommended
    for item in results:
        if "flash" in item["id"] and "lite" not in item["id"] and "preview" not in item["id"]:
            item["tag"] = "Fast · Recommended"
            break

    return results
