"""Host-agnostic formatting and threshold logic for usage-hud.

Python port of packages/core-ts/src/{config,snapshot,format,thresholds}.ts.
Keep the two in sync - both are graded against the same spec/fixtures/*.json.
Snapshots and config are plain dicts (not dataclasses) so they map 1:1 onto
the JSON fixtures with no marshalling layer to keep in sync separately.
"""
from __future__ import annotations

import time
from typing import Any, Optional

DEFAULT_CONFIG: dict[str, Any] = {
    "footer": {
        "enabled": True,
        "template": None,
        "fields": ["model", "tokens", "context", "cost"],
    },
    "command": {
        "enabled": True,
        "name": "usage",
    },
    "alerts": {
        "context": {"enabled": True, "thresholdPct": 80},
        "budget": {"enabled": True, "thresholdPct": 20},
        "cooldownSec": 900,
    },
}


def resolve_config(partial: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Merges a partial user config over DEFAULT_CONFIG. Never mutates inputs."""
    partial = partial or {}
    footer = partial.get("footer") or {}
    command = partial.get("command") or {}
    alerts = partial.get("alerts") or {}
    alerts_context = alerts.get("context") or {}
    alerts_budget = alerts.get("budget") or {}

    return {
        "footer": {
            "enabled": footer.get("enabled", DEFAULT_CONFIG["footer"]["enabled"]),
            "template": footer.get("template", DEFAULT_CONFIG["footer"]["template"]),
            "fields": footer.get("fields", DEFAULT_CONFIG["footer"]["fields"]),
        },
        "command": {
            "enabled": command.get("enabled", DEFAULT_CONFIG["command"]["enabled"]),
            "name": command.get("name", DEFAULT_CONFIG["command"]["name"]),
        },
        "alerts": {
            "context": {
                "enabled": alerts_context.get("enabled", DEFAULT_CONFIG["alerts"]["context"]["enabled"]),
                "thresholdPct": alerts_context.get(
                    "thresholdPct", DEFAULT_CONFIG["alerts"]["context"]["thresholdPct"]
                ),
            },
            "budget": {
                "enabled": alerts_budget.get("enabled", DEFAULT_CONFIG["alerts"]["budget"]["enabled"]),
                "thresholdPct": alerts_budget.get(
                    "thresholdPct", DEFAULT_CONFIG["alerts"]["budget"]["thresholdPct"]
                ),
            },
            "cooldownSec": alerts.get("cooldownSec", DEFAULT_CONFIG["alerts"]["cooldownSec"]),
        },
    }


def _clamp_pct(n: float) -> float:
    return max(0, min(100, n))


def context_used_pct(snapshot: dict[str, Any]) -> Optional[int]:
    """Derives context.usedPct from usedTokens/limitTokens when not given directly."""
    ctx = snapshot.get("context")
    if not ctx:
        return None
    if ctx.get("usedPct") is not None:
        return int(_clamp_pct(ctx["usedPct"]))
    used = ctx.get("usedTokens")
    limit = ctx.get("limitTokens")
    if used is not None and limit:
        return int(_clamp_pct(round(used / limit * 100)))
    return None


def window_remaining_pct(window: dict[str, Any]) -> int:
    """Derives a quota window's remainingPct from usedPct when not given directly."""
    if window.get("remainingPct") is not None:
        return int(_clamp_pct(window["remainingPct"]))
    return int(_clamp_pct(100 - window["usedPct"]))


def short_model_name(model: str) -> str:
    """Strips a leading 'provider/' prefix, e.g. 'anthropic/claude-opus-4-8' -> 'claude-opus-4-8'."""
    return model.split("/", 1)[-1] if "/" in model else model


def _tokens_segment(snapshot: dict[str, Any]) -> Optional[str]:
    t = snapshot.get("tokens")
    if not t or (t.get("input") is None and t.get("output") is None):
        return None
    base = f"in {t.get('input') or 0}/out {t.get('output') or 0}"
    return f"{base} (cache {t['cacheRead']})" if t.get("cacheRead") else base


def _context_segment(snapshot: dict[str, Any]) -> Optional[str]:
    pct = context_used_pct(snapshot)
    return None if pct is None else f"ctx {pct}%"


def _cost_segment(snapshot: dict[str, Any]) -> Optional[str]:
    turn_usd = (snapshot.get("cost") or {}).get("turnUsd")
    return None if turn_usd is None else f"${turn_usd:.4f}"


def _quota_segment(snapshot: dict[str, Any]) -> Optional[str]:
    windows = (snapshot.get("quota") or {}).get("windows")
    if not windows:
        return None
    return ", ".join(f"{w['label']} {window_remaining_pct(w)}% left" for w in windows)


_SEGMENT_BUILDERS = {
    "model": lambda s: short_model_name(s["model"]),
    "tokens": _tokens_segment,
    "context": _context_segment,
    "cost": _cost_segment,
    "quota": _quota_segment,
}


def format_footer(snapshot: dict[str, Any], config: dict[str, Any]) -> str:
    """Renders the passive footer appended to an outbound reply.

    Returns "" when footer is disabled or there's nothing to show.
    """
    if not config["footer"]["enabled"]:
        return ""
    segments = [s for s in (_SEGMENT_BUILDERS[f](snapshot) for f in config["footer"]["fields"]) if s is not None]
    if not segments:
        return ""
    return "\n\n— " + " · ".join(segments)


def format_on_demand(snapshot: dict[str, Any]) -> str:
    """Renders the on-demand /usage reply - one labeled line per available field."""
    lines = [f"Model: {short_model_name(snapshot['model'])}"]

    t = snapshot.get("tokens")
    if t and (t.get("input") is not None or t.get("output") is not None):
        base = f"Tokens: in {t.get('input') or 0} / out {t.get('output') or 0}"
        lines.append(f"{base} (cache {t['cacheRead']})" if t.get("cacheRead") else base)

    pct = context_used_pct(snapshot)
    if pct is not None:
        ctx = snapshot["context"]
        lines.append(f"Context: {pct}% ({ctx.get('usedTokens', '?')} / {ctx.get('limitTokens', '?')})")

    cost = snapshot.get("cost") or {}
    if cost.get("turnUsd") is not None:
        turn = f"${cost['turnUsd']:.4f} this turn"
        lines.append(f"Cost: {turn} (${cost['sessionUsd']:.2f} session)" if cost.get("sessionUsd") is not None else f"Cost: {turn}")

    q = _quota_segment(snapshot)
    if q is not None:
        lines.append(f"Quota: {q}")

    return "\n".join(lines)


def _now_ms() -> int:
    return int(time.time() * 1000)


class AlertEngine:
    """Evaluates threshold crossings for one snapshot and tracks per-(session,
    kind, window) cooldown state in memory, per SPEC.md sec 4. One instance per
    plugin process is enough - cooldown state does not need to survive a restart.
    """

    def __init__(self, config: dict[str, Any]):
        self._config = config
        self._last_fired_at_ms: dict[str, int] = {}

    def _cooldown_key(self, session_key: Optional[str], kind: str, sub: str) -> str:
        return f"{session_key or ''}:{kind}:{sub}"

    def _in_cooldown(self, key: str, now_ms: int) -> bool:
        last = self._last_fired_at_ms.get(key)
        return last is not None and (now_ms - last) < self._config["alerts"]["cooldownSec"] * 1000

    def evaluate(self, snapshot: dict[str, Any], now_ms: Optional[int] = None) -> list[dict[str, Any]]:
        now_ms = _now_ms() if now_ms is None else now_ms
        fired: list[dict[str, Any]] = []
        session_key = (snapshot.get("route") or {}).get("sessionKey")

        ctx_config = self._config["alerts"]["context"]
        if ctx_config["enabled"]:
            pct = context_used_pct(snapshot)
            if pct is not None and pct >= ctx_config["thresholdPct"]:
                key = self._cooldown_key(session_key, "context", "context")
                if not self._in_cooldown(key, now_ms):
                    self._last_fired_at_ms[key] = now_ms
                    fired.append({
                        "kind": "context",
                        "text": f"⚠️ Context alert: context window at {pct}% (≥ {ctx_config['thresholdPct']}%)",
                    })

        budget_config = self._config["alerts"]["budget"]
        if budget_config["enabled"]:
            for window in (snapshot.get("quota") or {}).get("windows") or []:
                remaining_pct = window_remaining_pct(window)
                if remaining_pct <= budget_config["thresholdPct"]:
                    key = self._cooldown_key(session_key, "budget", window["label"])
                    if not self._in_cooldown(key, now_ms):
                        self._last_fired_at_ms[key] = now_ms
                        fired.append({
                            "kind": "budget",
                            "windowLabel": window["label"],
                            "text": f"⚠️ Budget alert: {window['label']} at {remaining_pct}% left (≤ {budget_config['thresholdPct']}%)",
                        })

        return fired
