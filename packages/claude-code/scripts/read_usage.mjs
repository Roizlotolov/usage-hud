#!/usr/bin/env node
/**
 * On-demand usage readout, invoked by skills/usage/SKILL.md. Claude Code has
 * no programmatic /usage JSON API (confirmed: the built-in /cost and /context
 * commands are terminal-only, human-formatted output), so this reads the same
 * per-session state file the statusline script maintains on every turn.
 */
import { formatOnDemand } from "@usage-hud/core";
import { readLatestState, readState } from "./lib.mjs";

const sessionId = process.argv[2];
const state = sessionId ? readState(sessionId) : readLatestState();

if (!state?.snapshot) {
  console.log("No usage data yet - the statusline script populates this after the first assistant response.");
  process.exit(0);
}

console.log(formatOnDemand(state.snapshot));
