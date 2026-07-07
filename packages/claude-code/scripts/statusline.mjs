#!/usr/bin/env node
/**
 * Claude Code statusLine command. Verified against the "Full JSON schema"
 * section of code.claude.com/docs/en/statusline - the statusline is the only
 * place in Claude Code that reliably has context/cost/rate-limit data on
 * every turn. See README "Why alerts live in the statusline script, not a
 * hook" for why this script also performs the alert side effect, not just
 * the terminal HUD.
 */
import { AlertEngine, formatFooter, resolveConfig } from "@usage-hud/core";
import { loadConfigFromEnv, mapStatuslineInputToSnapshot, readState, sendTelegramAlert, writeState } from "./lib.mjs";

async function main() {
  const raw = await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // malformed input - print nothing rather than crash the status line
  }

  const sessionId = input.session_id ?? "unknown";
  const state = readState(sessionId);
  const snapshot = mapStatuslineInputToSnapshot(input, state.lastCost ?? 0);

  const config = resolveConfig(loadConfigFromEnv());
  process.stdout.write(formatFooter(snapshot, config).replace(/^\n\n/, "")); // no leading blank lines in a terminal bar

  const engine = new AlertEngine(config);
  engine.loadState(state.alertState ?? {});
  const fired = engine.evaluate(snapshot);
  if (fired.length > 0) {
    await sendTelegramAlert(fired.map((a) => a.text).join("\n"));
  }

  writeState(sessionId, {
    snapshot,
    lastCost: snapshot.cost?.sessionUsd ?? state.lastCost ?? 0,
    alertState: engine.getState(),
  });
}

main();
