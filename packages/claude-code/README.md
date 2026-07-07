# @usage-hud/claude-code

Surfaces Claude Code's own usage/context/cost data as a terminal HUD, optional
Telegram alerts, and an on-demand skill. Reuses Claude Code's own accounting —
it never re-meters tokens.

## Why alerts live in the statusline script, not a hook

The original plan (see `DESIGN.md` §6.3, before this package was built) assumed
a `Stop`/`SessionEnd` hook could read `context_window`/`cost` from its stdin
JSON and shell out to Telegram. **That's wrong** — fetching the real, current
[hooks reference](https://code.claude.com/docs/en/hooks) confirms hook input is
limited to `session_id`, `transcript_path`, `cwd`, `permission_mode`, and a
handful of event-specific fields (`tool_name`, `tool_input`, …). It says so
explicitly: *"the documentation does NOT include fields for `context_window`,
`cost`, or `token_usage` — these are not exposed in hook input."*

The **statusline** script is the only place in Claude Code that reliably has
this data on every turn (see the ["Full JSON schema"](https://code.claude.com/docs/en/statusline)
section). So this package puts everything in `scripts/statusline.mjs`: it
prints the terminal HUD (its actual job) *and*, as a side effect, checks
alert thresholds and fires a Telegram message when one is crossed. This is a
real architectural finding from verifying against current docs, not a design
preference.

## Install

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/usage-hud/packages/claude-code/scripts/statusline.mjs"
  }
}
```

Copy `skills/usage/` into your `~/.claude/skills/` directory (or a project's
`.claude/skills/`) for the on-demand surface, and edit the path inside
`SKILL.md` to match where you cloned this repo.

For Telegram delivery, install the official Channels plugin (`claude
--channels plugin:telegram@claude-plugins-official` — research preview as of
this writing) so Claude's own replies reach Telegram, and separately set:

```bash
export USAGE_HUD_TELEGRAM_BOT_TOKEN="123456:ABC..."
export USAGE_HUD_TELEGRAM_CHAT_ID="987654321"
```

before launching `claude`. This can be a different bot than Channels uses —
the statusline script talks to the Telegram Bot API directly, independent of
Channels.

## What it does

| Surface | Mechanism | Notes |
|---|---|---|
| HUD | `statusLine` command, printed to stdout | This *is* the terminal status bar — surface (a) is the feature's native use case here. |
| On-demand | `skills/usage/SKILL.md` + `scripts/read_usage.mjs` | Reads the same per-session state file the statusline script writes on every turn — there's no other programmatic way to get this data (confirmed: `/cost`/`/context` are human-formatted terminal commands with no JSON API). |
| Alerts | Side effect inside `scripts/statusline.mjs`, via the Telegram Bot API | See above. Cooldown state persists to `~/.claude/usage-hud/state/<session_id>.json` via `AlertEngine.getState()`/`loadState()` (added to `@usage-hud/core` specifically for this — a statusline script is a fresh process every invocation, so in-memory cooldown state alone would never actually cool down). |

## Mapping notes (verified against the official "Full JSON schema")

- `context.usedPct` is Claude Code's own pre-calculated `context_window.used_percentage` — passed straight through rather than re-derived, per that field's docs: "Pre-calculated percentage of context window used."
- `cost.total_cost_usd` is a **cumulative session total**, not a per-turn cost — Claude Code does not expose a per-turn figure. `cost.turnUsd` is derived here as the delta against the previous invocation's total (saved in the state file), the same reasoning any diff-based cost meter would use.
- `context_window.current_usage` is `null` before the first API call and again right after `/compact` — the tokens segment is simply omitted for that invocation (SPEC.md's graceful-degradation rule), not shown as 0.
- `rate_limits` (5h/7-day) is Claude.ai Pro/Max-subscriber-only and may be entirely absent — mapped to `quota.windows` when present, omitted otherwise.

## Config (environment variables)

Same variable names and semantics as the Hermes plugin, since Claude Code's `settings.json` has no structured slot to pass config into an arbitrary `statusLine` command either — set these in your shell profile or inline them into the `command` string.

| Variable | Default |
|---|---|
| `USAGE_HUD_FOOTER_ENABLED` | `true` |
| `USAGE_HUD_FOOTER_FIELDS` | `model,tokens,context,cost` (comma-separated; add `quota` to show rate limits) |
| `USAGE_HUD_ALERT_CONTEXT_ENABLED` / `_THRESHOLD_PCT` | `true` / `80` |
| `USAGE_HUD_ALERT_BUDGET_ENABLED` / `_THRESHOLD_PCT` | `true` / `20` |
| `USAGE_HUD_ALERT_COOLDOWN_SEC` | `900` |
| `USAGE_HUD_TELEGRAM_BOT_TOKEN` / `_CHAT_ID` | unset (alerts stay silent until both are set) |

## Manual testing

Per the official docs' own recommended pattern:

```bash
echo '{"session_id":"test","model":{"id":"claude-opus-4-8"},"cost":{"total_cost_usd":0.05},"context_window":{"total_input_tokens":85000,"context_window_size":100000,"used_percentage":85,"current_usage":{"input_tokens":80000,"output_tokens":5000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}' \
  | node scripts/statusline.mjs
node scripts/read_usage.mjs test
rm -rf ~/.claude/usage-hud/state/test.json  # clean up test state
```

## Not implemented (honestly out of scope)

- **`subagentStatusLine`** — a separate, differently-shaped hook for per-subagent rows; not wired up here.
- **Programmatic `/cost`/`/context` override** — not possible; those remain Claude Code's own built-ins, unaffected by this package.
