---
type: Runbook
title: Usage HUD Repository Operations
status: active
tags: [project-kb, usage-hud, hermes, openclaw, claude-code, telemetry]
last_verified: 2026-07-10
---

# Usage HUD Repository Operations

Use this lightweight runbook for scoped repo work in `/home/hermes/projects/usage-hud`.

## Default workflow

1. When changing the output contract, update `SPEC.md`, fixtures, TypeScript core, and the Hermes Python port together.
2. Run `npm run build` and `npm test` for JS workspace changes.
3. Run `cd packages/hermes-plugin && python3 -m unittest discover -s test -v` for Hermes plugin changes; it is intentionally pure Python and does not require Hermes installed for these tests.

## Commit hygiene

- Check `git status --short --branch` before editing.
- Stage only the intended scoped paths.
- Run `git diff --check` before commit.
- Push to the configured `origin` after a clean logical commit unless Roi has asked otherwise.
