# usage-hud (Hermes plugin)

Surfaces Hermes' own usage/context/cost data into chat. Reuses `agent.usage_pricing`
for cost and Hermes' own on-disk context-length cache — it never re-meters tokens.

Everything below was verified by cloning `NousResearch/hermes-agent` and reading
the real source (`agent/conversation_loop.py`, `agent/turn_finalizer.py`,
`agent/usage_pricing.py`, `agent/model_metadata.py`, `gateway/session.py`,
`gateway/session_context.py`, `gateway/delivery.py`, `gateway/run.py`,
`hermes_cli/plugins.py`, `hermes_cli/commands.py`, and the bundled
`plugins/observability/langfuse` reference plugin) — not assumed from docs alone.

## Install

```bash
cp -r usage-hud ~/.hermes/plugins/usage-hud
hermes plugins enable usage-hud
hermes gateway restart
```

The restart is required if the gateway is already running: `discover_plugins()`
is idempotent by default and only rescans manifests when explicitly forced
*within the current process* (`hermes_cli/plugins.py`) — `hermes plugins
enable` is a separate, short-lived CLI invocation that writes to config, it
does not reach into an already-running gateway process to force a reload. If
you haven't started the gateway yet, `hermes gateway start` picks up the
newly enabled plugin on its own first launch and no restart is needed.

## What it does

| Surface | Mechanism | Notes |
|---|---|---|
| Footer | `transform_llm_output` hook return value | Appended to the reply text. Only the *first* non-empty string any plugin returns wins — Hermes does not chain transforms (verified in `turn_finalizer.py`). If another `transform_llm_output` plugin is also enabled, only one of you will actually apply. |
| On-demand | `/cost` command | `/usage`, `/status`, `/footer`, `/context`, `/compress` are Hermes built-ins (confirmed against the real `CommandDef` list in `hermes_cli/commands.py`) — `register_command()` silently rejects a conflicting name, so this plugin uses `/cost`. |
| Alerts | `gateway.delivery_router.deliver(...)` | A genuine out-of-band push — see below. This is the one surface where Hermes is strictly more capable than OpenClaw for a third-party plugin. |

## Verified hook semantics (the parts worth knowing before you touch this code)

- **Hooks are called synchronously.** `PluginManager.invoke_hook` does `ret = cb(**kwargs)` with no `await` and no coroutine handling. Hook callbacks in this plugin (`_on_post_api_request`, `_on_transform_llm_output`, `_on_pre_gateway_dispatch`) are plain `def`, not `async def` — an async hook handler here would silently do nothing (its coroutine object is never awaited).
- **`post_api_request` fires once per LLM API call**, not once per turn — a turn with tool calls fires it multiple times. Its `usage` dict (`agent/usage_pricing.py`'s `CanonicalUsage`, `asdict()`-ed) has keys `input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, request_count, prompt_tokens, total_tokens`. Storing the snapshot on every call and reading it back once per turn (in `transform_llm_output`, which fires after the tool loop) naturally captures the *last* call's `prompt_tokens` — the right end-of-turn context occupancy, with no extra bookkeeping.
- **`post_llm_call` does NOT carry usage data.** An earlier draft of this plugin registered it as a "cross-version fallback" based on a secondhand description; the real call site (`turn_finalizer.py`) passes `session_id, task_id, turn_id, user_message, assistant_response, conversation_history, model, platform` — no `usage` key, ever, in this version. It exists for a different purpose (persisting conversation data). Registering it added nothing, so this plugin doesn't.
- **`register_command` handlers receive only `raw_args`.** The real call site (`gateway/run.py`: `plugin_handler(user_args)`) confirms there is no session/user identity parameter at all. Naively keying off "whatever was last stored" would leak one user's usage numbers to another user's `/cost` on a shared multi-user gateway. This plugin instead reads `gateway.session_context.get_session_env("HERMES_SESSION_ID")` — a `contextvars.ContextVar` Hermes sets per-message specifically so concurrent sessions don't cross-contaminate (see that module's own docstring on the exact bug class it exists to prevent) — to look up the *current* session's snapshot.
- **`PluginContext` has no config-passing mechanism.** No `plugin_config` attribute, no `get_config()` method — checked every method on the class. The bundled reference plugin (`plugins/observability/langfuse`) configures itself entirely through environment variables, and this plugin follows the same pattern (see Config below) rather than assuming a `plugins.entries.<id>.config` object that doesn't exist in the plugin API.
- **`agent.session_id` is not a platform chat_id.** `DeliveryTarget` needs a real `chat_id`/`thread_id`/`Platform`, which live on `SessionEntry.origin` (a `SessionSource`), not on the opaque session id our hooks receive. Alerts resolve delivery targets via `session_store.lookup_by_session_id(session_id).origin`, captured from `pre_gateway_dispatch`'s `session_store` kwarg.
- **Context-window size is looked up from Hermes' own on-disk cache only** (`agent.model_metadata.get_cached_context_length`), never the live-probing `get_model_context_length`. The latter can make network calls (Anthropic/Copilot/OpenRouter/Ollama probes) on a cache miss, and since hooks are synchronous, that would block the turn. The cache is normally already warm because Hermes' own context engine resolves the same model during ordinary use — so context% just doesn't appear on the very first turn for a brand-new model, then works from then on. This is the honest tradeoff, not a bug.

## Config (environment variables)

| Variable | Default |
|---|---|
| `USAGE_HUD_FOOTER_ENABLED` | `true` |
| `USAGE_HUD_FOOTER_FIELDS` | `model,tokens,context,cost` (comma-separated) |
| `USAGE_HUD_COMMAND_ENABLED` | `true` |
| `USAGE_HUD_COMMAND_NAME` | `cost` |
| `USAGE_HUD_ALERT_CONTEXT_ENABLED` / `_THRESHOLD_PCT` | `true` / `80` |
| `USAGE_HUD_ALERT_BUDGET_ENABLED` / `_THRESHOLD_PCT` | `true` / `20` |
| `USAGE_HUD_ALERT_COOLDOWN_SEC` | `900` |

Set these via `hermes tools` or `~/.hermes/.env`, same as the Langfuse plugin's own env vars.

See [`SPEC.md`](../../SPEC.md) for the full config semantics and format rules — `core.py` here is a straight Python port of `packages/core-ts`, graded against the same `spec/fixtures/*.json`.

## Development

```bash
python3 -m unittest discover -s test -v
```

`test/test_fixtures.py` runs the shared `spec/fixtures/*.json` vectors against `core.py` so this port can't silently drift from the TypeScript one. `test/test_mapping.py` covers the plugin-specific glue (`_build_snapshot`, env-based config) in isolation — it does not require Hermes itself to be installed, since the `agent.*` imports are wrapped in `try/except` and degrade to omitting cost/context, exactly as they would on a real install with a cold cache.
