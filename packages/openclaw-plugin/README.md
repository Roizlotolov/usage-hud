# @usage-hud/openclaw-plugin

Surfaces OpenClaw's own usage/context/cost data into chat. Reuses OpenClaw's
`reply_payload_sending` hook — it never re-meters tokens.

## Install

```bash
openclaw plugins install ./packages/openclaw-plugin --link   # local dev
openclaw plugins enable usage-hud
openclaw gateway restart
openclaw plugins inspect usage-hud --runtime --json           # confirm hooks/commands registered
```

## Troubleshooting: no footer showing up

Check these in order:

1. **`hooks.allowConversationAccess: true` is missing from your config.** This is the #1 cause. A non-bundled plugin does not receive `reply_payload_sending` at all without it — silently, no error. See [Config](#config) below for the exact block.
2. **`dist/index.js` doesn't exist.** If you ran `openclaw plugins install` before `npm run build`, the plugin has no entry point to load. Rebuild (`npm run build` at the repo root) and restart the gateway.
3. **Confirm the hook is actually registered:** `openclaw plugins inspect usage-hud --runtime --json` should list `reply_payload_sending` under the plugin's hooks and `/quota` under its commands. If it shows zero hooks, the plugin failed to load — check gateway logs for a load error around plugin startup.
4. **`event.usageState` may genuinely be absent for a given reply** (documented as happening on durable/replay delivery paths — see the source comment in `PluginHookReplyPayloadSendingEvent`). If steps 1-3 all check out, this is the remaining possibility; it's host behavior, not a plugin bug.

## What it does

| Surface | Mechanism | Notes |
|---|---|---|
| Footer | `reply_payload_sending` hook return value | Appended to every reply's `text`. |
| On-demand | `/quota` command | `usage`/`status`/`context` are reserved by OpenClaw core, so a third-party plugin cannot register them. |
| Alerts | Prepended to the **next outbound reply** | See limitation below — this is not an out-of-band push. |

## Verified limitation: no true proactive push for third-party plugins

OpenClaw's own SDK docs (`docs/plugins/sdk-overview.md`) state plainly:

> `api.session.workflow.scheduleSessionTurn(...)` — **Bundled-only** Cron-backed scheduled session turns
> `api.session.workflow.sendSessionAttachment(...)` — **Bundled-only** host-mediated file attachment delivery

This was confirmed by installing `openclaw@2026.6.11` from npm and reading the actual type declarations and bundled docs directly — not assumed from external blog posts. `api.runtime.state` (a keyed store that would otherwise be a natural place to persist alert state) is also flagged bundled-only in this release.

**Consequence:** a third-party plugin cannot wake up and push an unsolicited message into a Telegram/Discord/Slack thread. The only channel-write access a non-bundled plugin reliably has is the return value of hooks that fire *during* an existing turn.

**What this plugin does instead:** threshold checks run on every `reply_payload_sending` event (i.e., every real reply the agent sends). When a threshold is crossed, the alert text is prepended to that same reply — so you find out on the very next thing the agent says, not from a special standalone message. For an always-on agent that's usually seconds away, but it is not instantaneous the way a Cron-scheduled push would be.

If you need a true out-of-band push, the sanctioned paths are: (a) publish this plugin as a bundled/first-party OpenClaw plugin, or (b) build it as a channel plugin that owns outbound delivery directly (see `docs/plugins/sdk-channel-outbound.md`). Both are out of scope for v1.

## Config

Set under `plugins.entries.usage-hud.config` in your OpenClaw config, and set `hooks.allowConversationAccess: true` on the same entry so a non-bundled plugin receives `reply_payload_sending`:

```jsonc
{
  plugins: {
    entries: {
      "usage-hud": {
        enabled: true,
        hooks: { allowConversationAccess: true },
        config: {
          footer: { enabled: true, fields: ["model", "tokens", "context", "cost"] },
          command: { enabled: true, name: "quota" },
          alerts: {
            context: { enabled: true, thresholdPct: 80 },
            budget: { enabled: true, thresholdPct: 20 },
            cooldownSec: 900,
          },
        },
      },
    },
  },
}
```

See [`SPEC.md`](../../SPEC.md) for the full config schema and format rules.

## State

- Per-session last-usage cache (for `/quota`) and the alert cooldown tracker both live in **process memory** — they reset on gateway restart. This mirrors SPEC.md's "cooldown state need not persist" allowance, extended here because `api.runtime.state` isn't available to this plugin.

## Development

```bash
npm run build   # tsc, type-checks against the real installed `openclaw` package
npm test        # unit tests for the usageState -> UsageSnapshot mapping
```
