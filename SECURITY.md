# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security concern.

Use GitHub's private reporting instead: go to the
[Security tab](https://github.com/Roizlotolov/usage-hud/security) of this
repository → **Report a vulnerability**. This opens a private advisory
visible only to the maintainer until a fix is ready.

## Scope

This project is a set of plugins/scripts that read usage data a host
(OpenClaw, Hermes Agent, Claude Code) already computed, and optionally send a
short text message to a chat channel or the Telegram Bot API. Relevant
security concerns include:

- Anything that could leak conversation content, tokens, or credentials beyond what the host itself already exposes to a plugin
- Anything that could be used to send messages to an unintended recipient (e.g. a `chat_id`/`session_id` confusion — this project has already found and fixed one class of this bug in the Hermes adapter; see `packages/hermes-plugin/README.md`)
- Injection via config values (env vars, plugin config) into a shell command or HTTP request

Out of scope: vulnerabilities in the host projects themselves (OpenClaw,
Hermes Agent, Claude Code) — please report those upstream.

## Supported versions

This project has not yet reached a `1.0` release. Fixes land on `main`; there
is no separate maintenance branch yet.
