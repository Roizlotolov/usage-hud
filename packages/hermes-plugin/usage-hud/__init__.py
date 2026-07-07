"""usage-hud - surfaces Hermes' existing usage/context/cost into chat.

Reuses agent.usage_pricing for cost and agent.model_metadata's on-disk cache
for context-window size - never re-meters tokens. See README.md for the
verified hook/API surface this relies on, and its documented limitations.
"""
import asyncio
import os
import threading

import core as _core  # core.py lives next to this file (see plugin.yaml)

_LOCK = threading.Lock()
_CONFIG: dict = _core.DEFAULT_CONFIG
_ALERT_ENGINE = _core.AlertEngine(_CONFIG)
_LAST_SNAPSHOT_BY_SESSION: dict[str, dict] = {}
_GATEWAY = None  # captured via pre_gateway_dispatch for alert delivery
_SESSION_STORE = None  # captured alongside _GATEWAY; resolves session_id -> chat_id for delivery


def _cost_for(model: str, usage: dict, provider: str, base_url: str) -> float | None:
    try:
        from agent.usage_pricing import CanonicalUsage, estimate_usage_cost

        cu = CanonicalUsage(
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            cache_read_tokens=usage.get("cache_read_tokens", 0),
            cache_write_tokens=usage.get("cache_write_tokens", 0),
            reasoning_tokens=usage.get("reasoning_tokens", 0),
        )
        result = estimate_usage_cost(model, cu, provider=provider, base_url=base_url)
        return float(result.amount_usd) if result.amount_usd is not None else None
    except Exception:
        return None


def _context_limit_for(model: str, base_url: str) -> int | None:
    """Best-effort, local-only lookup - never probes the network.

    get_model_context_length() can do live network probes on a cold cache,
    which would block this hook's caller (Hermes invokes plugin hooks
    synchronously - see README "Verified hook semantics"). Its on-disk cache
    is normally already warm because Hermes' own context engine resolves this
    for the same model during ordinary use, so we read that cache directly and
    simply omit context% if it hasn't been populated yet.
    """
    try:
        from agent.model_metadata import get_cached_context_length

        return get_cached_context_length(model, base_url or "")
    except Exception:
        return None


def _build_snapshot(*, model, provider, base_url, usage, session_id, platform) -> dict | None:
    if not model:
        return None
    snapshot: dict = {"model": model}
    if provider:
        snapshot["provider"] = provider

    if usage:
        snapshot["tokens"] = {
            "input": usage.get("input_tokens"),
            "output": usage.get("output_tokens"),
            "cacheRead": usage.get("cache_read_tokens"),
            "cacheWrite": usage.get("cache_write_tokens"),
            "total": usage.get("total_tokens"),
        }
        cost_usd = _cost_for(model, usage, provider, base_url)
        if cost_usd is not None:
            snapshot["cost"] = {"turnUsd": cost_usd}
        prompt_tokens = usage.get("prompt_tokens")
        limit_tokens = _context_limit_for(model, base_url)
        if prompt_tokens is not None and limit_tokens:
            snapshot["context"] = {"usedTokens": prompt_tokens, "limitTokens": limit_tokens}

    if session_id or platform:
        snapshot["route"] = {"sessionKey": session_id, "channel": platform}

    return snapshot


def _fire_and_forget(coro):
    """Runs an async delivery call from Hermes' synchronous hook context.

    Hermes invokes plugin hooks synchronously (PluginManager.invoke_hook calls
    `cb(**kwargs)` directly, no await) - see README. If we're already on a
    running event loop (the common case, since the gateway is asyncio-based),
    schedule it there. Otherwise spin up a short-lived loop on a daemon thread
    so a hook that happens to run off-loop doesn't silently drop the alert.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        loop.create_task(coro)
    else:
        threading.Thread(target=lambda: asyncio.run(coro), daemon=True).start()


def _delivery_target_for_session(session_id: str):
    """Resolves a real chat_id/thread_id for session_id via the session store.

    agent.session_id (what our hooks receive) is Hermes' internal identifier,
    NOT the platform chat_id DeliveryTarget needs - see README "Why alerts use
    the session store, not the session_id string". SessionEntry.origin carries
    the actual routing info recorded when the session was created.
    """
    if _SESSION_STORE is None:
        return None
    entry = _SESSION_STORE.lookup_by_session_id(session_id)
    if entry is None or entry.origin is None or entry.platform is None:
        return None
    from gateway.delivery import DeliveryTarget

    return DeliveryTarget(
        platform=entry.platform,
        chat_id=entry.origin.chat_id,
        thread_id=entry.origin.thread_id,
        is_explicit=True,
    )


def _maybe_alert(snapshot: dict) -> str:
    """Fires threshold alerts.

    Prefers a genuine out-of-band push via gateway.delivery_router - Hermes,
    unlike OpenClaw, exposes this to third-party plugins (see README). Falls
    back to inlining the alert into the next reply only when no gateway/route
    is available yet (e.g. pure-CLI mode, or the session store has no entry
    for this session_id). Returns the inline suffix to append to the reply,
    or "" once the alert has been delivered out-of-band.
    """
    fired = _ALERT_ENGINE.evaluate(snapshot)
    if not fired:
        return ""
    text = "\n".join(a["text"] for a in fired)

    if _GATEWAY is not None:
        session_id = (snapshot.get("route") or {}).get("sessionKey") or ""
        target = _delivery_target_for_session(session_id)
        if target is not None:
            _fire_and_forget(_GATEWAY.delivery_router.deliver(text, [target]))
            return ""  # delivered out-of-band - don't also duplicate it inline

    return "\n\n" + text


def _on_post_api_request(*, session_id="", model="", provider="", base_url="", platform="", usage=None, **_kwargs):
    if not isinstance(usage, dict):
        return
    with _LOCK:
        snapshot = _build_snapshot(
            model=model, provider=provider, base_url=base_url, usage=usage, session_id=session_id, platform=platform
        )
        if snapshot and session_id:
            _LAST_SNAPSHOT_BY_SESSION[session_id] = snapshot


def _on_transform_llm_output(*, response_text="", session_id="", model="", platform="", **_kwargs):
    """Fires once per turn. Only the first non-empty string returned by any
    plugin wins (Hermes does not chain transforms) - see README.
    """
    with _LOCK:
        snapshot = _LAST_SNAPSHOT_BY_SESSION.get(session_id)
    if not snapshot:
        return None

    suffix = _maybe_alert(snapshot)
    if _CONFIG["footer"]["enabled"]:
        suffix += _core.format_footer(snapshot, _CONFIG)
    if not suffix:
        return None
    return response_text + suffix


def _on_pre_gateway_dispatch(*, event=None, gateway=None, session_store=None, **_kwargs):
    global _GATEWAY, _SESSION_STORE
    if _GATEWAY is None:
        _GATEWAY = gateway
        _SESSION_STORE = session_store
    return None  # None/{"action": "allow"} - never alter dispatch


def _cmd_cost(raw_args: str) -> str:
    """register_command() only passes raw_args - no session identity (verified
    at the call site in gateway/run.py: `plugin_handler(user_args)`). Reading
    the current session id from gateway.session_context is what makes this
    correct on a multi-user gateway instead of leaking whichever session's
    message happened to arrive last across ALL users. See README.
    """
    try:
        from gateway.session_context import get_session_env

        session_id = get_session_env("HERMES_SESSION_ID")
    except Exception:
        session_id = ""

    with _LOCK:
        snapshot = _LAST_SNAPSHOT_BY_SESSION.get(session_id) if session_id else None
    if not snapshot:
        return "No usage data yet - send a message first."
    return _core.format_on_demand(snapshot)


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    return default if raw is None else raw.strip().lower() in ("1", "true", "yes", "on")


def _load_config_from_env() -> dict:
    """Builds a partial UsageHudConfig from env vars.

    PluginContext has no config-passing mechanism (no `plugin_config`
    attribute, no `get_config()` - verified by reading every method on the
    class). Every bundled plugin that needs its own settings, including the
    reference Langfuse observability plugin, reads env vars instead. See
    README "Why env vars, not plugins.entries.<id>.config".
    """
    partial: dict = {
        "footer": {"enabled": _bool_env("USAGE_HUD_FOOTER_ENABLED", True)},
        "command": {
            "enabled": _bool_env("USAGE_HUD_COMMAND_ENABLED", True),
            "name": os.environ.get("USAGE_HUD_COMMAND_NAME", "cost"),
        },
        "alerts": {
            "context": {
                "enabled": _bool_env("USAGE_HUD_ALERT_CONTEXT_ENABLED", True),
                "thresholdPct": float(os.environ.get("USAGE_HUD_ALERT_CONTEXT_THRESHOLD_PCT", "80")),
            },
            "budget": {
                "enabled": _bool_env("USAGE_HUD_ALERT_BUDGET_ENABLED", True),
                "thresholdPct": float(os.environ.get("USAGE_HUD_ALERT_BUDGET_THRESHOLD_PCT", "20")),
            },
            "cooldownSec": float(os.environ.get("USAGE_HUD_ALERT_COOLDOWN_SEC", "900")),
        },
    }
    fields = os.environ.get("USAGE_HUD_FOOTER_FIELDS")
    if fields:
        partial["footer"]["fields"] = [f.strip() for f in fields.split(",") if f.strip()]
    return partial


def register(ctx) -> None:
    global _CONFIG, _ALERT_ENGINE
    _CONFIG = _core.resolve_config(_load_config_from_env())
    _ALERT_ENGINE = _core.AlertEngine(_CONFIG)

    ctx.register_hook("post_api_request", _on_post_api_request)
    ctx.register_hook("transform_llm_output", _on_transform_llm_output)
    ctx.register_hook("pre_gateway_dispatch", _on_pre_gateway_dispatch)

    if _CONFIG["command"]["enabled"]:
        # "usage", "status", "footer", "compress" are Hermes built-ins and
        # register_command() silently rejects conflicts - default to "cost".
        name = _CONFIG["command"]["name"]
        ctx.register_command(
            "cost" if name in ("usage", "status", "footer", "compress") else name,
            _cmd_cost,
            description="Show token usage, context, and cost for the current session",
        )
