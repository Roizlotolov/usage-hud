---
type: Project Overview
title: Usage HUD Overview
status: active
tags: [project-kb, usage-hud, hermes, openclaw, claude-code, telemetry]
last_verified: 2026-07-10
---

# Usage HUD Overview

Monorepo for usage/context HUD adapters across Hermes Agent, OpenClaw, and Claude Code.

## Repository

- Path: `/home/hermes/projects/usage-hud`
- Global KB page: `/home/hermes/projects/zloto-knowledge-base/projects/usage-hud.md`

## Boundary and current shape

- The canonical cross-adapter contract is `SPEC.md` plus fixture files under `spec/fixtures/`.
- TypeScript workspaces cover shared core, OpenClaw plugin, and Claude Code statusline/skill; the Hermes plugin is a Python package under `packages/hermes-plugin`.
- The project intentionally reads host-provided usage/context data instead of re-metering tokens itself.

## Verification anchors

- `npm run build` builds JS workspaces.
- `npm test` runs workspace tests; Hermes plugin Python tests run from `packages/hermes-plugin` with `python3 -m unittest discover -s test -v`.

## Caveat

This page is based on repository inspection on 2026-07-10. Treat runtime state, production deployments, analytics delivery, provider credentials, and live customer data as live-system facts that must be re-verified before operational claims.
