# Usage HUD — Design & Implementation Plan

> Real-time context-size and remaining-usage visibility for chat-based AI agents
> (Claude Code, OpenClaw, Hermes) delivered *into the channel* (Telegram / Discord / Slack …).

**Status:** research complete, ready for implementation.
**This document is self-contained** — the implementation session (Sonnet) should be able to build from this alone. Every host API named here was verified against official docs and/or source; items that need a runtime spike are flagged in **§9 Risks & spikes**.

---

## 1. Problem

When you talk to a self-hosted AI agent through a normal chat channel (Telegram/Discord/Slack), you lose the HUD the native apps give you. You cannot see, in real time:

1. **Context size** — how full the model's context window is. Drives *quality*: when it fills, the agent silently compacts/forgets.
2. **Remaining usage** — tokens / dollars / provider-quota left. Drives *cost*: what stops an always-on agent quietly burning money overnight.

These agents run **24/7 and unattended** (scheduled jobs, browser automation, sub-agents), so the spend and context-bloat happen while you're not looking, and your only interface is a chat bubble with no meter.

## 2. Core principle — **reuse, don't re-meter**

All three hosts **already compute** tokens, context %, cost, and (often) provider quota. They just don't surface it to non-terminal channels or proactively. So this project is a **bridge/HUD**, not a metering engine:

> read the numbers the host already produced → format them → emit them into the channel → watch thresholds → alert before damage.

We never call a tokenizer and never maintain our own pricing table (except optional graceful fallback). Confirmed data sources per host are in §6.

## 3. What is genuinely new (the pitch / README framing)

The hosts already show this data in a terminal or on request. Our value-add is exactly the gap:

1. **Delivery to non-terminal channels** — get the HUD out of the terminal and into Telegram/Discord/Slack.
2. **Proactive threshold alerts** — warn at "context > 80%" or "quota < 20%" *before* damage, without the user asking.
3. **One consistent config + format across all three agents** — same footer, same alerts, one mental model whether you run OpenClaw, Hermes, or Claude Code.

## 4. Target hosts & the cross-language reality

| Host | Plugin language | Primary use of chat channels | Telegram support |
|---|---|---|---|
| **OpenClaw** | Node / **TypeScript** | Primary (it's a chat gateway) | native (multiple channels) |
| **Hermes** | **Python 3.11** | Primary (it's a chat gateway) | native (20+ platforms) |
| **Claude Code** | language-agnostic scripts | Secondary (terminal-first) | official **Channels** plugin (research preview): `/plugin install telegram@claude-plugins-official`, then `claude --channels plugin:telegram@claude-plugins-official`. Not on Bedrock/Vertex/Foundry. |

**Consequence:** there is **no single importable library**. The adapters are in different languages. What we share is a **spec** (canonical snapshot + config schema + output format), plus a small **TypeScript core** reused by OpenClaw *and* Claude Code (both can run Node), with a **Python port** of that core for Hermes.

## 5. Architecture

### 5.1 Repo layout (monorepo)

```
usage-hud/                         # name TBD — see §11
├── README.md                      # portfolio framing (§3), install per host, screenshots
├── LICENSE                        # MIT (see §11)
├── DESIGN.md                      # this file
├── SPEC.md                        # canonical UsageSnapshot + config schema + format rules
├── spec/
│   ├── config.schema.json         # JSON Schema for the shared config (§5.4)
│   └── fixtures/                  # golden snapshots -> expected footer/alert strings
│                                  #   (shared test vectors so TS & Python stay in sync)
├── packages/
│   ├── core-ts/                   # TS: UsageSnapshot type, formatter, threshold engine, config
│   │   ├── src/{snapshot,format,thresholds,config}.ts
│   │   └── test/ (runs spec/fixtures)
│   ├── openclaw-plugin/           # TS plugin, depends on core-ts
│   ├── claude-code/               # statusline + hook scripts + skill (+ optional MCP), Node, deps core-ts
│   └── hermes-plugin/             # Python plugin + usage_hud/ (Python port of core), runs spec/fixtures
└── examples/                      # sample configs per host
```

**Sharing rationale:** the OpenClaw plugin and the Claude Code Node scripts import `core-ts` directly. The Hermes `usage_hud` Python module re-implements the same tiny logic (format + thresholds) and is kept honest by running the **same `spec/fixtures/` golden vectors**. The core logic is small; a Python port is cheaper than a cross-language IPC layer.

> **Simpler alternative if we want to ship faster:** skip `core-ts` as a shared dep and make three self-contained adapters unified only by `SPEC.md`. The monorepo+core version shows more engineering maturity for a portfolio; start with one adapter end-to-end (§8) and extract `core-ts` once the format stabilizes.

### 5.2 Data flow (identical shape on every host)

```
host lifecycle hook  ──►  adapter maps host fields ──►  UsageSnapshot
                                                          │
                    ┌─────────────────────────────────────┼─────────────────────────────┐
                    ▼                                       ▼                             ▼
        format.footer(snapshot)              thresholds.evaluate(snapshot)      format.onDemand(snapshot)
                    │                                       │                             │
          append to outbound reply             if crossed → host send API        reply to /usage command
             (surface a)                            (surface c)                      (surface b)
```

### 5.3 Canonical `UsageSnapshot` (the shared contract)

Every adapter maps its host's fields into this. All fields optional except `model`; formatter degrades gracefully (renders only what's present).

```ts
type UsageSnapshot = {
  model: string;                 // e.g. "claude-opus-4-8"
  provider?: string;             // e.g. "anthropic"
  tokens?: {                     // TURN aggregate (summed across tool-loop calls)
    input?: number; output?: number;
    cacheRead?: number; cacheWrite?: number;
    total?: number;
  };
  context?: {                    // for "how full is the window"
    usedTokens?: number;         // end-of-turn occupancy (NOT cumulative session total)
    limitTokens?: number;        // effective window
    usedPct?: number;            // 0..100 (derive if not given: used/limit*100)
  };
  cost?: { turnUsd?: number; sessionUsd?: number };   // omit if no pricing configured
  quota?: {                      // "remaining usage" — provider-dependent, often absent
    windows?: Array<{ label: string; usedPct: number; remainingPct?: number; resetAt?: number }>;
  };
  route?: { sessionKey?: string; channel?: string; agentId?: string };  // for alert targeting
};
```

### 5.4 Shared config schema (all three surfaces are toggles over one snapshot)

```jsonc
{
  "footer":  { "enabled": true,  "template": null, "fields": ["model","tokens","context","cost"] },
  "command": { "enabled": true,  "name": "usage" },      // name overridable — some hosts reserve /usage
  "alerts": {
    "context": { "enabled": true, "thresholdPct": 80 },  // warn when context usedPct >= 80
    "budget":  { "enabled": true, "thresholdPct": 20 },  // warn when quota remainingPct <= 20
    "cooldownSec": 900                                    // anti-spam per (session, alert-type)
  }
}
```

The user asked for **all three surfaces configurable** — this schema delivers that; each adapter reads the same config and wires each toggle to the host mechanism in §6.

---

## 6. Per-host integration matrix (the implementation meat)

Legend: **(a)** passive footer/HUD · **(b)** on-demand `/usage` · **(c)** proactive alert.

### 6.1 OpenClaw  — TypeScript plugin

- **Plugin shape:** `package.json` (with `openclaw` block) + `openclaw.plugin.json` (manifest, `configSchema` **required**) + entry exporting `definePluginEntry({ id, name, description, register(api){} })`. Install: `openclaw plugins init|install ./… --link`, `openclaw plugins enable <id>`, `openclaw gateway restart`. Verify: `openclaw plugins inspect <id> --runtime --json`.
- **Usage source (single richest object):** `api.on("reply_payload_sending", …)` → `event.usageState` (`PluginHookReplyUsageState`). Fields: `provider, model, resolvedRef, turnUsd, durationMs, compactionCount, contextTokenBudget, contextUsedTokens, usage{input,output,cacheRead,cacheWrite,total}, lastUsage{…}, sessionId, chatType, agentId`. `usage` = turn aggregate; `contextUsedTokens` = end-of-turn occupancy (use for context %). **Null-guard `usageState`** — absent on durable/replay paths. (Per-call alt: `llm_output` with `usage{input,output,cacheRead,cacheWrite,total}` + `contextTokenBudget`/`contextWindowReferenceTokens`.)
- **(a) Footer:** in `reply_payload_sending`, **return** `{ payload: { ...event.payload, text: (event.payload.text ?? "") + footer } }` (return value, not mutation; handlers run sequentially by `priority`). Overlaps built-in footer (`messages.responseUsage` / `messages.usageTemplate`) — offer ours for richer format.
- **(b) On-demand:** `api.registerCommand({ name: "quota", … })`. ⚠️ **`usage` and `status` are reserved** built-in names — third-party plugins cannot claim them. Use `/quota` (config `command.name` default should account for this per-host).
- **(c) Alert — CONFIRMED, not just suspected:** built and compiled `packages/openclaw-plugin` against the real `openclaw@2026.6.11` npm package (installed as a devDependency for accurate type-checking, not guessed). Its own bundled docs (`docs/plugins/sdk-overview.md`) state plainly: `api.session.workflow.scheduleSessionTurn(...)` is **"Bundled-only"**, as is `sendSessionAttachment(...)` and — notably — `api.runtime.state` ("Bundled plugins only in this release"). A third-party plugin has **no sanctioned out-of-band push**. **Implemented behavior:** evaluate thresholds inside `reply_payload_sending` (which already fires every real turn) and prepend the alert text to that same outbound reply, instead of a separate unsolicited message. Cooldown/last-snapshot state lives in an in-process `Map` (not `api.runtime.state`). This is not "v1.1 pending a spike" — it's the correct, final v1 design for a third-party OpenClaw plugin. See `packages/openclaw-plugin/README.md` for the full writeup.
- **Quota ("remaining usage"):** per-provider fetchers from `openclaw/plugin-sdk/provider-usage`: `fetchClaudeUsage, fetchCodexUsage, fetchDeepSeekUsage, fetchGeminiUsage, fetchMinimaxUsage, fetchZaiUsage` (+ `clampPercent`, `PROVIDER_LABELS`, types `ProviderUsageSnapshot`/`UsageWindow` where `remaining = 100 - usedPercent`). No aggregate exported — assemble yourself, or shell `openclaw status --usage --json`.
- **Config gotcha:** non-bundled plugins need `hooks: { allowConversationAccess: true }` in `plugins.entries.<id>` to receive conversation hooks like `reply_payload_sending`. Resolved config available as `ctx.pluginConfig` in every handler.

### 6.2 Hermes  — Python 3.11 plugin

Built and tested against a real clone of `NousResearch/hermes-agent` (not just docs). Several assumptions from the research phase turned out wrong on contact with source — corrected below; see `packages/hermes-plugin/README.md` for the full verified writeup.

- **Plugin shape:** dir with `plugin.yaml` (manifest, `provides_hooks:`) + `__init__.py` exporting `register(ctx)`. Install to `~/.hermes/plugins/<name>/`, then `hermes plugins enable <name>`. **Hooks are called synchronously** (`PluginManager.invoke_hook` does `cb(**kwargs)`, no `await`) — hook handlers must be plain `def`, not `async def`.
- **Usage source:** `ctx.register_hook("post_api_request", cb)` — fires **per LLM API call**; `usage` dict (confirmed via `CanonicalUsage`/`asdict()`) = `{input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, request_count, prompt_tokens, total_tokens}`. **Correction:** `post_llm_call` does **not** carry a `usage` kwarg at all in this version (its real kwargs are `session_id, task_id, turn_id, user_message, assistant_response, conversation_history, model, platform` — for persisting conversation data, not usage). Don't register it for this purpose. Cost: reuse `from agent.usage_pricing import CanonicalUsage, estimate_usage_cost` (do **not** re-meter).
- **Context %:** `compute_session_context_breakdown(agent)` needs a live `agent` object hooks don't have — confirmed, not just suspected (no `session_store` method returns one). **Resolution used:** read Hermes' own on-disk cache directly, `agent.model_metadata.get_cached_context_length(model, base_url)` — local-only, no network. The live-probing `get_model_context_length` is deliberately avoided since a network call inside a synchronous hook would block the turn; context% simply doesn't appear until Hermes' own context engine has warmed that model's cache during ordinary use.
- **(a) Footer:** `ctx.register_hook("transform_llm_output", cb)` where `cb(response_text, session_id, model, platform, **kwargs) -> str | None`; return augmented string (fires after tool loop, before delivery; **first non-empty wins — Hermes does not chain transforms**, so a second `transform_llm_output` plugin would compete with this one, not compose).
- **(b) On-demand:** `ctx.register_command("cost", handler, description=…)`. `/usage`, `/status`, `/footer`, `/context`, `/compress` are confirmed built-in (`CommandDef` list in `hermes_cli/commands.py`) → use `/cost`. **Correction:** the real handler call site (`gateway/run.py`: `plugin_handler(user_args)`) confirms **no session identity is passed at all** — using "whichever session was stored last" would leak one user's numbers to another's `/cost` on a shared gateway. Fixed by reading `gateway.session_context.get_session_env("HERMES_SESSION_ID")`, a per-message `contextvars.ContextVar` Hermes sets specifically to prevent this class of cross-session leak.
- **(c) Alert — genuine out-of-band push, unlike OpenClaw:** capture `gateway` and `session_store` via `ctx.register_hook("pre_gateway_dispatch", cb)` (`cb(event, gateway, session_store, **kwargs)`); send with `await gateway.delivery_router.deliver(text, [target])`. **Correction:** `agent.session_id` (what hooks receive) is **not** a platform `chat_id` — building `DeliveryTarget.parse(f"{platform}:{session_id}")` directly would target the wrong/nonexistent chat. The real routing info is `session_store.lookup_by_session_id(session_id).origin` (a `SessionSource` with `chat_id`/`thread_id`/`platform`), confirmed via `gateway/session.py`. Dispatch the coroutine with a running-loop check + daemon-thread fallback (`asyncio.get_running_loop()` else spin a thread with `asyncio.run(...)`), since hooks may or may not run on the gateway's own loop.
- **Config — no `plugins.entries.<id>.config` object exists.** Read every method on `PluginContext`: no `plugin_config` attribute, no `get_config()`. The bundled reference plugin (`plugins/observability/langfuse`) configures itself entirely via environment variables — this plugin follows the same real pattern instead of a config-passing mechanism that doesn't exist in the API.

### 6.3 Claude Code  — Node.js scripts, `@usage-hud/core` reused directly

Built against the current official docs, re-fetched during implementation (not just the research-phase brief). **This surfaced a real correction to the original plan:** the hooks reference states outright — *"the documentation does NOT include fields for `context_window`, `cost`, or `token_usage` — these are not exposed in hook input."* Hook stdin is limited to `session_id`, `transcript_path`, `cwd`, `permission_mode`, and event-specific fields (`tool_name`, `tool_input`, …). A `Stop`-hook-reads-usage-and-curls-Telegram design, as originally planned, is not buildable — a hook simply never sees the numbers.

- **(a) Passive HUD = statusline.** `~/.claude/settings.json` → `"statusLine": { "type": "command", "command": "…" }`. Confirmed exact schema via the docs' own "Full JSON schema" accordion: `model.id`, `cost.total_cost_usd` (cumulative **session** total, not per-turn), `context_window.{total_input_tokens,context_window_size,used_percentage,current_usage}` (the last is `null` before the first API call and again right after `/compact`), `rate_limits.{five_hour,seven_day}.used_percentage` (Claude.ai Pro/Max subscribers only, may be absent). Runs after every assistant message, after `/compact`, and on permission-mode/vim-mode changes. **Terminal-only — cannot itself push to Telegram.**
- **(c) Alert — moved into the statusline script, not a hook.** Since the statusline is the *only* place with reliable per-turn usage data, `packages/claude-code/scripts/statusline.mjs` does double duty: prints the terminal HUD *and*, as a side effect, checks thresholds and POSTs to the Telegram Bot API directly (independent of the Channels plugin) when one fires. Because a statusline script is a **fresh process every invocation** (unlike OpenClaw/Hermes's long-running gateway), in-memory cooldown state alone would never actually cool down — `AlertEngine` gained `getState()`/`loadState()` in `core-ts` specifically for this, persisted to `~/.claude/usage-hud/state/<session_id>.json` between invocations.
- **`cost.turnUsd` doesn't exist as a host-provided field** — Claude Code only exposes the cumulative session total. Derived here as the delta against the previous invocation's total (same state file), the same reasoning any diff-based cost meter would use.
- **(b) On-demand:** built-in `/usage`/`/context`/`/cost` remain human-formatted, terminal-only, with no JSON API (confirmed) — a custom skill (`skills/usage/SKILL.md`) instructs the agent to run `scripts/read_usage.mjs`, which reads the *same* per-session state file the statusline script already maintains, rather than re-deriving anything.
- **Telegram:** official **Channels** plugin (research preview) bridges Claude's own replies — separate and independent from this package's direct-to-Telegram-Bot-API alert path.
- **Also available:** OpenTelemetry metrics export (enterprise; needs a collector) for out-of-band monitoring — not used here.

### 6.4 Surface × host summary

| | OpenClaw | Hermes | Claude Code |
|---|---|---|---|
| **(a) HUD/footer** | `reply_payload_sending` return payload | `transform_llm_output` return str | statusline (terminal); `Stop` hook → curl for Telegram |
| **(b) /usage** | `registerCommand("quota")` | `register_command("cost")` | built-in `/usage` + skill/MCP |
| **(c) alert** | `scheduleSessionTurn` ⚠️ | `delivery_router.deliver` | `Stop`/`SessionEnd` hook → curl |
| **usage data** | `usageState` (rich) | `post_api_request.usage` | statusline/hook JSON |
| **context %** | `contextUsedTokens/contextTokenBudget` | `context_compressor` / `compute_session_context_breakdown` | `context_window.used_percentage` |
| **quota** | per-provider `fetch*Usage()` | `account_usage.build_credits_view` | `rate_limits` in JSON |
| **risk level** | med (alert path) | low–med (undocumented hook) | low |

---

## 7. v1 scope

**In v1 (all three hosts):** surface (a) footer/HUD + surface (b) on-demand. These are low-risk everywhere.

**Alerts (c):** ship for all three hosts in v1. Hermes and Claude Code get a true out-of-band push (`delivery_router.deliver` / a hook shelling out to the Telegram bot API). OpenClaw gets the same-reply-prepend design confirmed in §6.1 — there is no spike left to gate on; the bundled-only restriction is confirmed from the real package, not suspected.

**Out of scope for v1:** multi-account aggregation, historical dashboards, web UI, cross-session budgets. The snapshot + config are designed so these are additive later.

## 8. Build order for the implementation session

1. **`SPEC.md` + `spec/config.schema.json` + `spec/fixtures/`** — lock the `UsageSnapshot`, config, and golden footer/alert strings first. Everything else conforms to this.
2. **`packages/core-ts`** — `snapshot`, `format` (footer/onDemand/alert text), `thresholds` (evaluate + cooldown), `config` (parse/validate). Unit-test against `spec/fixtures/`.
3. **OpenClaw adapter** (footer + `/quota` + same-reply alerts) — richest single object, pure TS (reuses core directly). Built and type-checked against the real `openclaw` npm package; see §6.1 for the confirmed alert-delivery design.
4. **Hermes adapter** — port core to `usage_hud/` (Python), run it against `spec/fixtures/`; footer via `transform_llm_output`, `/cost` command, alerts via `delivery_router`. **Validate `post_api_request` + agent-handle bridge early** (§9).
5. **Claude Code adapter** — statusline HUD script that also performs the alert side effect (see §6.3 for why hooks can't), plus a skill for on-demand. Node, imports `@usage-hud/core` directly like the OpenClaw adapter.
6. **README + LICENSE + examples + screenshots** for the portfolio.

> Rationale for OpenClaw-then-Hermes-first: those are the chat gateways where this problem is primary and are the user's main tools; Claude Code is the third/bonus host.

## 9. Risks & spikes — validate BEFORE building on these

**Do these runtime checks first; do not assume.**

1. ~~OpenClaw `scheduleSessionTurn`~~ **RESOLVED, not just spiked.** Confirmed bundled-only by installing the real `openclaw@2026.6.11` package and reading its type declarations + bundled docs directly (`docs/plugins/sdk-overview.md`: "Bundled-only Cron-backed scheduled session turns"). `packages/openclaw-plugin` implements and compiles the same-reply-alert fallback described in §6.1 — done, not pending.
2. **OpenClaw `allowConversationAccess`.** Confirm it's required on the installed version for `reply_payload_sending` (non-bundled). If so, document it in install steps.
3. ~~Hermes `post_api_request` undocumented~~ **RESOLVED.** Confirmed real and stable by reading `agent/conversation_loop.py` directly. **Also found: the brief's suggested `post_llm_call` fallback was wrong** — that hook never carries `usage` in this version (verified at its call site in `turn_finalizer.py`). `packages/hermes-plugin` registers only `post_api_request`.
4. ~~Hermes agent handle in `transform_llm_output`~~ **RESOLVED — no agent handle exists, confirmed not assumed.** No `SessionStore` method returns a live agent. `packages/hermes-plugin` reads Hermes' own on-disk context-length cache (`agent.model_metadata.get_cached_context_length`) instead, keyed by model — see README for why the live-probing variant is deliberately avoided (network call inside a synchronous hook).
5. ~~Hermes threading~~ **RESOLVED.** `_fire_and_forget()` in `packages/hermes-plugin/usage-hud/__init__.py` checks for a running loop via `asyncio.get_running_loop()` and falls back to a daemon thread running `asyncio.run(...)` when hooks execute off-loop. **Also found and fixed two related bugs the original design didn't anticipate:** (a) `agent.session_id` is not a platform `chat_id` — `DeliveryTarget` needs `session_store.lookup_by_session_id(session_id).origin`, not the session id itself; (b) `register_command` handlers receive no session identity at all, so `/cost` must read `gateway.session_context.get_session_env("HERMES_SESSION_ID")` (a per-message `ContextVar`) instead of "last snapshot stored" — otherwise one user's `/cost` could show another user's numbers on a shared gateway.
6. ~~Hermes plugin config mechanism~~ **NEW FINDING, RESOLVED.** Not in the original risk list because the research phase assumed a `plugins.entries.<id>.config` object would be passed to `register(ctx)`. Reading every method on `PluginContext` found none (`plugin_config` doesn't exist; no `get_config()`) — the real, working pattern (used by the bundled Langfuse plugin) is environment variables. `packages/hermes-plugin` follows suit; see its README's config table.
7. ~~Claude Code JSON field paths~~ **RESOLVED — and the original assumption was wrong, not just unverified.** Re-fetched the current official docs during implementation: hook stdin does **not** carry `context_window`/`cost`/`token_usage` at all (confirmed explicitly in the hooks reference) — the planned "Stop hook reads usage, curls Telegram" design was never buildable. Rearchitected per §6.3: alerts moved into the statusline script, the one place that verifiably has this data every turn. The statusline JSON field paths themselves (`context_window.used_percentage`, `cost.total_cost_usd`, `rate_limits.*`) were confirmed correct against the docs' own "Full JSON schema" block and exercised with real mock input in `packages/claude-code/scripts/statusline.mjs`.
8. **Claude Code Channels is a research preview** — Telegram command syntax and availability may change; treat as beta in docs. (Unaffected by finding #7 — this package's alert path talks to the Telegram Bot API directly and doesn't depend on Channels.)
9. **Streaming footers.** On heavily-streamed platforms, verify the appended footer isn't dropped (Hermes has a `send_trailing_footer()` fallback; mirror if needed).

## 10. Graceful degradation rules (bake into the formatter)

- Missing `cost` (no pricing table configured) → omit the cost segment, don't error.
- Missing `quota` (provider not supported) → omit the "X% left" segment; budget alerts simply don't fire.
- Missing `context.limitTokens` → show token count without a percentage.
- `usageState`/`usage` null (replay/durable path) → skip footer for that message silently.

## 11. Meta

- **License:** **MIT** — it's a separate plugin talking over documented extension APIs (not a derivative of the hosts), and MIT maximizes adoption + is the cleanest portfolio signal. (Apache-2.0 only if an explicit patent grant is wanted; avoid GPL for a plugin.)
- **Name:** TBD. Candidates: `usage-hud`, `context-hud`, `token-hud`, `convo-meter`, `ctxmeter`. Recommend a clear descriptive name + tagline ("A usage & context HUD for chat-based AI agents") over a cute one for a portfolio piece.
- **Portfolio README** should lead with the §3 pitch, a per-host install section, and a GIF/screenshot of the footer + an alert firing in Telegram.

---

## Appendix — key source identifiers (for the implementer)

**OpenClaw** (`openclaw/openclaw`, TS) — verified against the real `openclaw@2026.6.11` npm package installed as a devDependency and type-checked, not just browsed: `dist/plugin-sdk/types-CR1WAXpo.d.ts` (`PluginHookReplyUsageState`, `OpenClawPluginCommandDefinition`, `OpenClawPluginSessionWorkflowApi`), `dist/plugin-sdk/hook-types-YIiTro9N.d.ts` (`PluginHookReplyPayloadSendingEvent`), `dist/plugin-sdk/core.d.ts` (import barrel actually used by `packages/openclaw-plugin`), bundled docs `node_modules/openclaw/docs/plugins/{building-plugins,manifest,sdk-overview,sdk-runtime,sdk-channel-outbound}.md`, `dist/command-registration-*.js` (`getReservedCommands()` — the literal reserved-name list).

**Hermes** (`NousResearch/hermes-agent`, Python) — verified against a real git clone, not just docs: `agent/conversation_loop.py` (`post_api_request` emission, :4243-4275), `agent/turn_finalizer.py` (`transform_llm_output` and `post_llm_call` call sites — this is where the "`post_llm_call` carries usage" assumption was found wrong), `run_agent.py` (`_usage_summary_for_api_request_hook`), `agent/usage_pricing.py` (`CanonicalUsage`, `estimate_usage_cost`), `agent/model_metadata.py` (`get_cached_context_length` vs the network-probing `get_model_context_length`), `gateway/session.py` (`SessionEntry`, `SessionSource`, `lookup_by_session_id` — no live-agent accessor exists), `gateway/session_context.py` (the `ContextVar`-based per-message session identity a command handler can read), `gateway/delivery.py` (`DeliveryTarget`, `DeliveryRouter.deliver`), `gateway/run.py` (`delivery_router` assignment, `pre_gateway_dispatch` call site, plugin-command dispatch call site `plugin_handler(user_args)`), `hermes_cli/plugins.py` (`PluginContext`, `VALID_HOOKS`, `register_command`'s built-in-conflict guard, `PluginManager.invoke_hook`'s synchronous `cb(**kwargs)`), `hermes_cli/commands.py` (the real built-in `CommandDef` list), `plugins/observability/langfuse/__init__.py` (reference plugin — confirms env-var config is the real pattern).

**Claude Code** (Anthropic) — docs re-fetched live during implementation (not just the research-phase brief), which is what caught the hooks/usage-data correction in §6.3/§9: `code.claude.com/docs/en/statusline` (the "Full JSON schema" accordion — the actual source for every field `scripts/lib.mjs` maps), `code.claude.com/docs/en/hooks` (the "Key Limitations" section confirming no context/cost/usage in hook input), repo `anthropics/claude-plugins-official` for Channels.
