import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".claude", "usage-hud", "state");

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true });
}

export function stateFilePath(sessionId) {
  return join(STATE_DIR, `${sessionId}.json`);
}

/** { snapshot, lastCost, alertState } or defaults if this session has no file yet. */
export function readState(sessionId) {
  try {
    return JSON.parse(readFileSync(stateFilePath(sessionId), "utf8"));
  } catch {
    return { snapshot: null, lastCost: 0, alertState: {} };
  }
}

export function writeState(sessionId, state) {
  ensureStateDir();
  writeFileSync(stateFilePath(sessionId), JSON.stringify(state), "utf8");
}

/** Most recently modified session state file - used when the caller (a
 * skill-invoked helper script) doesn't know its own session_id. Good enough
 * for the common case of one active Claude Code session per terminal. */
export function readLatestState() {
  let latestPath = null;
  let latestMtime = -Infinity;
  try {
    for (const name of readdirSync(STATE_DIR)) {
      if (!name.endsWith(".json")) continue;
      const path = join(STATE_DIR, name);
      const mtime = statSync(path).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latestPath = path;
      }
    }
  } catch {
    return null;
  }
  if (!latestPath) return null;
  try {
    return JSON.parse(readFileSync(latestPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Maps Claude Code's statusline JSON (code.claude.com/docs/en/statusline,
 * verified against the "Full JSON schema" section) onto UsageSnapshot.
 *
 * turnUsd is NOT provided by Claude Code (cost.total_cost_usd is a cumulative
 * SESSION total) - it's derived here as the delta against the previous
 * invocation's total, which is the same reasoning a diff-based cost meter
 * would use. previousCost is this session's last total_cost_usd (0 if none).
 */
export function mapStatuslineInputToSnapshot(input, previousCost) {
  const snapshot = { model: input.model?.id ?? input.model?.display_name ?? "unknown" };

  const usage = input.context_window?.current_usage;
  if (usage) {
    snapshot.tokens = {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
    };
  }

  const ctx = input.context_window;
  if (ctx && ctx.context_window_size) {
    snapshot.context = {
      usedTokens: ctx.total_input_tokens,
      limitTokens: ctx.context_window_size,
      usedPct: ctx.used_percentage ?? undefined, // Claude Code pre-calculates this; reuse it directly
    };
  }

  const totalCostUsd = input.cost?.total_cost_usd;
  if (totalCostUsd !== undefined && totalCostUsd !== null) {
    const turnUsd = Math.max(0, totalCostUsd - previousCost);
    snapshot.cost = { turnUsd, sessionUsd: totalCostUsd };
  }

  const windows = [];
  const fiveHour = input.rate_limits?.five_hour?.used_percentage;
  const sevenDay = input.rate_limits?.seven_day?.used_percentage;
  if (fiveHour !== undefined && fiveHour !== null) windows.push({ label: "5h limit", usedPct: fiveHour });
  if (sevenDay !== undefined && sevenDay !== null) windows.push({ label: "7d limit", usedPct: sevenDay });
  if (windows.length > 0) snapshot.quota = { windows };

  if (input.session_id) snapshot.route = { sessionKey: input.session_id };

  return snapshot;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Builds a partial UsageHudConfig from env vars - same pattern as the Hermes
 * plugin (packages/hermes-plugin/usage-hud/__init__.py), since Claude Code's
 * settings.json has no structured place to pass config into an arbitrary
 * statusLine command either; env vars set in the user's shell profile (or
 * inlined into the settings.json command string) are the natural fit. */
export function loadConfigFromEnv() {
  const partial = {
    footer: { enabled: boolEnv("USAGE_HUD_FOOTER_ENABLED", true) },
    alerts: {
      context: {
        enabled: boolEnv("USAGE_HUD_ALERT_CONTEXT_ENABLED", true),
        thresholdPct: Number(process.env.USAGE_HUD_ALERT_CONTEXT_THRESHOLD_PCT ?? 80),
      },
      budget: {
        enabled: boolEnv("USAGE_HUD_ALERT_BUDGET_ENABLED", true),
        thresholdPct: Number(process.env.USAGE_HUD_ALERT_BUDGET_THRESHOLD_PCT ?? 20),
      },
      cooldownSec: Number(process.env.USAGE_HUD_ALERT_COOLDOWN_SEC ?? 900),
    },
  };
  const fields = process.env.USAGE_HUD_FOOTER_FIELDS;
  if (fields) partial.footer.fields = fields.split(",").map((f) => f.trim()).filter(Boolean);
  return partial;
}

/**
 * Sends a Telegram message as a side effect. Silently no-ops if the bot
 * isn't configured or the request fails/times out - an alert delivery
 * failure must never break the statusline itself. Kept to a short timeout
 * since statusline scripts must stay fast (docs: "Slow scripts block the
 * status line from updating"); this only runs on the rare invocation where a
 * threshold actually fires; see README "Why alerts live in the statusline
 * script, not a hook".
 */
export async function sendTelegramAlert(text) {
  const token = process.env.USAGE_HUD_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.USAGE_HUD_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // best-effort only
  }
}
