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
# The `rm -rf` keeps re-installs idempotent: `cp -r usage-hud <dir>` copies the
# source *into* <dir> when it already exists, nesting it one level too deep as
# ~/.hermes/plugins/usage-hud/usage-hud/ (which Hermes never loads). See
# Troubleshooting. It also clears any stale __pycache__ from an earlier copy.
rm -rf ~/.hermes/plugins/usage-hud
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
**Changes to `~/.hermes/.env` require a gateway restart** (`hermes gateway
restart`, or `systemctl --user restart hermes-gateway` on systemd --user
setups) — the gateway reads `.env` once at startup, before it loads plugins.

### Footer fields

`USAGE_HUD_FOOTER_FIELDS` is a comma-separated subset of the fields below,
rendered left-to-right in the order you list them:

| Field | Renders | Example |
|---|---|---|
| `model` | model name, `provider/` prefix stripped | `gpt-5.5` |
| `tokens` | this turn's input/output tokens (plus cache reads when present) | `in 328/out 5 (cache 18432)` |
| `context` | context-window occupancy | `ctx 7%` |
| `cost` | estimated USD cost of the turn | `$0.0000` |

For example `USAGE_HUD_FOOTER_FIELDS=model,context` renders `— gpt-5.5 · ctx 7%`.
On a flat-rate / subscription backend `cost` is always `$0.0000`, so dropping it
is common. (`quota` is also accepted, but Hermes exposes no quota data to
plugins — `_build_snapshot` in `__init__.py` never populates it — so it renders
nothing and is omitted from the default field list.)

See [`SPEC.md`](../../SPEC.md) for the full config semantics and format rules — `core.py` here is a straight Python port of `packages/core-ts`, graded against the same `spec/fixtures/*.json`.

## Troubleshooting

### No footer *and* `/cost` is an unknown command

Both surfaces missing at once means the plugin **failed to load entirely**, so
`register()` never ran and neither the `transform_llm_output` hook nor the
`/cost` command was registered. Do not trust `hermes plugins list` here: its
`enabled` column reflects the `plugins.enabled` allow-list in `config.yaml`
(desired state), **not** whether the module imported. A failed load is logged
as `WARNING hermes_cli.plugins: Failed to load plugin 'usage-hud': <reason>`,
but the running gateway may not surface that logger at its default level — so
verify the install on disk instead. It's almost always one of two copy mistakes:

1. **The copy went one level too deep.** `cp -r usage-hud ~/.hermes/plugins/usage-hud`
   copies the source *into* the target when the target already exists, producing
   `~/.hermes/plugins/usage-hud/usage-hud/`. Discovery (`_scan_directory` in
   `hermes_cli/plugins.py`) treats the directory that has its own `plugin.yaml`
   as a *flat* plugin and never descends, so the nested copy is dead weight —
   and any older copy still at the top level keeps loading instead.

   ```bash
   ls -la ~/.hermes/plugins/usage-hud/
   # MUST show plugin.yaml, __init__.py, core.py DIRECTLY.
   # A usage-hud/ subdirectory here means the copy doubled up.
   ```

2. **A stale `__init__.py` still does `import core`.** Hermes loads a directory
   plugin as the package `hermes_plugins.<slug>` via
   `spec_from_file_location(..., submodule_search_locations=[plugin_dir])` — the
   plugin directory is on the *package's* search path but **not** on `sys.path`.
   A bare `import core` therefore raises `ModuleNotFoundError: No module named
   'core'` and takes the whole plugin down with it. The sibling import must be
   relative:

   ```bash
   grep -n '^from \. import core' ~/.hermes/plugins/usage-hud/__init__.py
   # Must match. `import core as _core` is the pre-fix version and will not load.
   ```

**Fix** — reinstall cleanly (clears a nested dir, a stale top-level copy, and
old bytecode in one shot), then restart the gateway:

```bash
rm -rf ~/.hermes/plugins/usage-hud
cp -r usage-hud ~/.hermes/plugins/usage-hud
hermes gateway restart          # systemd --user setups: systemctl --user restart hermes-gateway
```

### `/cost` returns real data, but there's still no footer

The plugin loaded — the footer is being suppressed at render time:

- **Footer switched off.** `USAGE_HUD_FOOTER_ENABLED=false` (or an empty
  `USAGE_HUD_FOOTER_FIELDS`) disables it. Restore it to `true` / a non-empty list.
- **Another plugin won the hook.** Only the *first* non-empty string any plugin
  returns from `transform_llm_output` is used — Hermes does not chain transforms
  (see [What it does](#what-it-does)). If a second enabled plugin also registers
  `transform_llm_output` and returns non-empty first, this plugin's footer is
  silently dropped. Ensure at most one enabled plugin owns that hook.
- **Cold context cache (not a bug).** `context%` alone is omitted on the very
  first turn for a brand-new model until Hermes' on-disk context-length cache
  warms; the rest of the footer still renders. See *Verified hook semantics*.

## Development

```bash
python3 -m unittest discover -s test -v
```

`test/test_fixtures.py` runs the shared `spec/fixtures/*.json` vectors against `core.py` so this port can't silently drift from the TypeScript one. `test/test_mapping.py` covers the plugin-specific glue (`_build_snapshot`, env-based config) in isolation — it does not require Hermes itself to be installed, since the `agent.*` imports are wrapped in `try/except` and degrade to omitting cost/context, exactly as they would on a real install with a cold cache.
