# SPEC — canonical contract shared by every adapter

This is the contract every host adapter (OpenClaw, Hermes, Claude Code, future
hosts) must conform to. It exists so that a footer, an on-demand reply, and an
alert look and behave the same regardless of which host produced them.

There are three parts:

1. **`UsageSnapshot`** — the shape every adapter maps its host's native fields into.
2. **Config** — the shared toggles for the three surfaces (footer / on-demand / alert). See [`spec/config.schema.json`](spec/config.schema.json).
3. **Format & threshold rules** — how a snapshot becomes footer text, on-demand text, and alert text/decisions. Golden examples live in [`spec/fixtures/`](spec/fixtures/) and are run by both `packages/core-ts` (TypeScript) and `packages/hermes-plugin` (Python) so the two implementations can't silently drift.

## 1. `UsageSnapshot`

All fields are optional except `model`. A conformant formatter renders only
what is present — a missing field is omitted from output, never shown as
`0`, `null`, or an error.

```ts
type UsageSnapshot = {
  model: string;                 // e.g. "claude-opus-4-8" — the only required field

  provider?: string;             // e.g. "anthropic", "openai"

  tokens?: {                     // TURN aggregate (summed across a tool-loop's calls),
    input?: number;              // NOT the cumulative session total
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };

  context?: {
    usedTokens?: number;         // end-of-turn occupancy of the context window
    limitTokens?: number;        // effective context window size
    usedPct?: number;            // 0..100; derived as usedTokens/limitTokens*100 if absent
  };

  cost?: {
    turnUsd?: number;            // cost of this turn only
    sessionUsd?: number;         // cumulative cost for the session, if known
  };

  quota?: {                      // provider-side remaining usage; often entirely absent
    windows?: Array<{
      label: string;             // e.g. "Claude weekly", "5-hour window"
      usedPct: number;           // 0..100
      remainingPct?: number;     // derived as 100 - usedPct if absent
      resetAt?: number;          // epoch millis, if known
    }>;
  };

  route?: {                      // for alert targeting — not rendered in footer/on-demand text
    sessionKey?: string;
    channel?: string;
    agentId?: string;
  };
};
```

### Field derivation rules (must hold in every adapter)

- `context.usedPct` — if absent but `usedTokens` and `limitTokens` are both present, derive as `round(usedTokens / limitTokens * 100)`. Clamp to `[0, 100]`.
- `quota.windows[].remainingPct` — if absent, derive as `100 - usedPct`. Clamp to `[0, 100]`.
- Adapters must use **end-of-turn context occupancy**, not a cumulative session total, for `context.usedTokens`. (A known bug class in these hosts is showing cumulative tokens over the window size, producing >100% — do not reproduce it.)

## 2. Config

See [`spec/config.schema.json`](spec/config.schema.json) for the full JSON Schema. Summary:

```jsonc
{
  "footer":  { "enabled": true, "template": null, "fields": ["model", "tokens", "context", "cost"] },
  "command": { "enabled": true, "name": "usage" },
  "alerts": {
    "context": { "enabled": true, "thresholdPct": 80 },
    "budget":  { "enabled": true, "thresholdPct": 20 },
    "cooldownSec": 900
  }
}
```

- `footer.fields` controls which segments appear, in order. Valid values: `"model"`, `"tokens"`, `"context"`, `"cost"`, `"quota"`.
- `footer.template` — reserved for a future custom-template string; `null` means "use the default renderer with `fields`".
- `command.name` — the on-demand command name. **Adapters must override the default when the host reserves the name** (e.g. OpenClaw reserves `usage`/`status`; Hermes reserves `usage`/`status`/`context`/`compress`/`footer`). Document the effective per-host default in each adapter's README.
- `alerts.context.thresholdPct` — fire when `context.usedPct >= thresholdPct`.
- `alerts.budget.thresholdPct` — fire when **any** `quota.windows[].remainingPct <= thresholdPct`.
- `alerts.cooldownSec` — minimum seconds between two alerts of the *same type* (`context` or `budget`) for the *same* `route.sessionKey`. Prevents alert spam on every turn once a threshold is crossed.

## 3. Format rules

### Footer

Plain text, appended to the outbound reply, prefixed with a separator line:

```
\n\n— {segments joined by " · "}
```

Segment rendering, in the order given by `footer.fields`, skipping any segment whose backing data is absent:

| field | condition to render | format |
|---|---|---|
| `model` | always (required field) | `{model}` (strip a `provider/` prefix if the model string has one) |
| `tokens` | `tokens.input` or `tokens.output` present | `in {input}/out {output}`, with `(cache {cacheRead})` appended in the same segment if `cacheRead` is truthy |
| `context` | `context.usedPct` derivable | `ctx {usedPct}%` |
| `cost` | `cost.turnUsd` present | `${turnUsd.toFixed(4)}` |
| `quota` | `quota.windows` non-empty | one clause per window: `{label} {remainingPct}% left` joined by `, ` |

Example (all fields, see `spec/fixtures/footer-full.json`):
```
— claude-opus-4-8 · in 1200/out 340 (cache 500) · ctx 41% · $0.0187 · Claude weekly 62% left
```

Example (partial data, no cost/quota configured, see `spec/fixtures/footer-partial.json`):
```
— claude-opus-4-8 · in 1200/out 340 · ctx 41%
```

### On-demand reply

Same segments as the footer, one per line, no separator prefix, each line labeled:

```
Model: {model}
Tokens: in {input} / out {output} (cache {cacheRead})
Context: {usedPct}% ({usedTokens} / {limitTokens})
Cost: ${turnUsd.toFixed(4)} this turn (${sessionUsd.toFixed(2)} session)
Quota: {label} {remainingPct}% left, ...
```
Omit any line whose backing data is absent. See `spec/fixtures/on-demand-full.json`.

### Alert text

```
⚠️ {kind === "context" ? "Context" : "Budget"} alert: {subject} at {value}% ({direction} {thresholdPct}%)
```
Where for `context`: `subject = "context window"`, `value = usedPct`, `direction = "≥"`.
For `budget`: `subject = "{window.label}"`, `value = remainingPct`, `direction = "≤"`.

Example: `⚠️ Context alert: context window at 85% (≥ 80%)`
Example: `⚠️ Budget alert: Claude weekly at 15% left (≤ 20%)`

See `spec/fixtures/alert-context.json` and `spec/fixtures/alert-budget.json`.

## 4. Threshold evaluation semantics

- Evaluated once per `UsageSnapshot` (i.e., once per turn), after the snapshot is fully populated.
- `context` alert: fires if `alerts.context.enabled` and `context.usedPct >= alerts.context.thresholdPct`.
- `budget` alert: fires once per window that crosses — if `alerts.budget.enabled` and any `quota.windows[i].remainingPct <= alerts.budget.thresholdPct`, fire one alert per such window.
- **Cooldown**: keyed by `(route.sessionKey, alertKind, windowLabel-or-"context")`. Suppress a repeat of the same key within `alerts.cooldownSec` seconds. Cooldown state is adapter-local (in-memory or host key-value store) — the spec does not mandate persistence across restarts.
- Crossing back below a threshold and back above it again is a new eligible firing (not blocked by cooldown once the cooldown window elapses).

## 5. Conformance

Any new adapter (or reimplementation of an existing one) is conformant if, given each `spec/fixtures/*.json` input, it produces the corresponding `*.expected.txt`/`*.expected.json` output. `packages/core-ts/test` and `packages/hermes-plugin/test` both run the full fixture set; a new language port should do the same before being trusted.
