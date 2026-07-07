import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotFromUsageState } from "../src/mapping.js";

test("maps a full usageState to a UsageSnapshot", () => {
  const snapshot = snapshotFromUsageState(
    {
      model: "anthropic/claude-opus-4-8",
      provider: "anthropic",
      usage: { input: 1200, output: 340, cacheRead: 500 },
      contextUsedTokens: 41000,
      contextTokenBudget: 100000,
      turnUsd: 0.0187,
      agentId: "main",
    },
    { sessionKey: "s1", channel: "telegram" },
  );

  assert.deepEqual(snapshot, {
    model: "anthropic/claude-opus-4-8",
    provider: "anthropic",
    tokens: { input: 1200, output: 340, cacheRead: 500, cacheWrite: undefined, total: undefined },
    context: { usedTokens: 41000, limitTokens: 100000 },
    cost: { turnUsd: 0.0187 },
    route: { sessionKey: "s1", channel: "telegram", agentId: "main" },
  });
});

test("returns undefined when usageState has no model", () => {
  const snapshot = snapshotFromUsageState({});
  assert.equal(snapshot, undefined);
});

test("omits context/cost/route segments the host didn't report", () => {
  const snapshot = snapshotFromUsageState({ model: "claude-opus-4-8" });
  assert.deepEqual(snapshot, { model: "claude-opus-4-8" });
});
