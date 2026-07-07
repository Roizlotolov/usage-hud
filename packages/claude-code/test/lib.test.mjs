import { test } from "node:test";
import assert from "node:assert/strict";
import { mapStatuslineInputToSnapshot, loadConfigFromEnv } from "../scripts/lib.mjs";

test("maps the full statusline JSON schema onto a UsageSnapshot", () => {
  const input = {
    session_id: "test-session",
    model: { id: "claude-opus-4-8", display_name: "Opus" },
    cost: { total_cost_usd: 0.08 },
    context_window: {
      total_input_tokens: 15500,
      context_window_size: 200000,
      used_percentage: 8,
      current_usage: { input_tokens: 8500, output_tokens: 1200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 2000 },
    },
    rate_limits: { five_hour: { used_percentage: 23.5 }, seven_day: { used_percentage: 41.2 } },
  };

  const snapshot = mapStatuslineInputToSnapshot(input, 0.05);

  assert.equal(snapshot.model, "claude-opus-4-8");
  assert.deepEqual(snapshot.tokens, { input: 8500, output: 1200, cacheRead: 2000, cacheWrite: 5000 });
  assert.deepEqual(snapshot.context, { usedTokens: 15500, limitTokens: 200000, usedPct: 8 });
  // turnUsd is a delta against the previous invocation's cumulative total, not a host-provided field
  assert.equal(snapshot.cost.turnUsd.toFixed(2), "0.03");
  assert.equal(snapshot.cost.sessionUsd, 0.08);
  assert.deepEqual(snapshot.quota.windows, [
    { label: "5h limit", usedPct: 23.5 },
    { label: "7d limit", usedPct: 41.2 },
  ]);
  assert.deepEqual(snapshot.route, { sessionKey: "test-session" });
});

test("omits tokens when current_usage is null (pre-first-call or post-/compact)", () => {
  const snapshot = mapStatuslineInputToSnapshot(
    { session_id: "s1", model: { id: "claude-opus-4-8" }, context_window: { current_usage: null, context_window_size: 200000 } },
    0,
  );
  assert.equal(snapshot.tokens, undefined);
});

test("omits quota entirely when rate_limits is absent (non-subscriber)", () => {
  const snapshot = mapStatuslineInputToSnapshot({ session_id: "s1", model: { id: "claude-opus-4-8" } }, 0);
  assert.equal(snapshot.quota, undefined);
});

test("turnUsd never goes negative even if cost appears to decrease", () => {
  const snapshot = mapStatuslineInputToSnapshot({ session_id: "s1", model: { id: "m" }, cost: { total_cost_usd: 0.01 } }, 0.05);
  assert.equal(snapshot.cost.turnUsd, 0);
});

test("loadConfigFromEnv reads USAGE_HUD_* overrides", () => {
  const saved = { ...process.env };
  process.env.USAGE_HUD_FOOTER_ENABLED = "false";
  process.env.USAGE_HUD_ALERT_CONTEXT_THRESHOLD_PCT = "90";
  process.env.USAGE_HUD_FOOTER_FIELDS = "model,cost";
  try {
    const partial = loadConfigFromEnv();
    assert.equal(partial.footer.enabled, false);
    assert.equal(partial.alerts.context.thresholdPct, 90);
    assert.deepEqual(partial.footer.fields, ["model", "cost"]);
  } finally {
    process.env = saved;
  }
});

test("loadConfigFromEnv defaults match core-ts DEFAULT_CONFIG when unset", () => {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("USAGE_HUD_")) delete process.env[key];
  }
  try {
    const partial = loadConfigFromEnv();
    assert.equal(partial.footer.enabled, true);
    assert.equal(partial.alerts.context.thresholdPct, 80);
    assert.equal(partial.alerts.budget.thresholdPct, 20);
    assert.equal(partial.alerts.cooldownSec, 900);
  } finally {
    process.env = saved;
  }
});
