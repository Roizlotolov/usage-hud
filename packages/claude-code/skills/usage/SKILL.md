---
name: usage
description: Reports current token usage, context window occupancy, and session cost. Use when the user asks about their usage, context size, how full the context window is, session cost, or how much they've spent.
---

# Usage HUD readout

Claude Code has no programmatic API for `/usage`/`/cost` data (they are
terminal-formatted, human-facing commands only), so this skill reads the
state file usage-hud's statusline script already maintains on every turn.

When the user asks about token usage, context window size, or session cost:

1. Run this command and relay its output verbatim (it is already formatted for chat):

   ```bash
   node <path-to-usage-hud>/packages/claude-code/scripts/read_usage.mjs
   ```

2. If it prints "No usage data yet...", tell the user the usage-hud statusline
   needs to run at least once first — that happens automatically after the
   next assistant response, as long as `statusLine` is configured in
   `~/.claude/settings.json` (see the package README).

Do not attempt to compute these numbers yourself from the conversation history
— they come from Claude Code's own accounting, which this skill's script
reads directly rather than re-deriving.
