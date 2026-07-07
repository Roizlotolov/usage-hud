import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertEngine } from "../src/thresholds.js";
import { resolveConfig } from "../src/config.js";
import type { UsageSnapshot } from "../src/types.js";

test("getState/loadState round-trips cooldown across engine instances", () => {
  const config = resolveConfig({ alerts: { context: { enabled: true, thresholdPct: 80 }, cooldownSec: 900 } });
  const snapshot: UsageSnapshot = {
    model: "claude-opus-4-8",
    context: { usedTokens: 85000, limitTokens: 100000 },
    route: { sessionKey: "s1" },
  };

  const first = new AlertEngine(config);
  const firedFirst = first.evaluate(snapshot, 0);
  assert.equal(firedFirst.length, 1);

  // Simulate a fresh process (e.g. a new statusline invocation) restoring
  // cooldown state saved to disk by the previous invocation.
  const second = new AlertEngine(config);
  second.loadState(first.getState());
  const firedSecond = second.evaluate(snapshot, 100_000); // 100s later, within cooldown
  assert.deepEqual(firedSecond, []);

  const firedThird = second.evaluate(snapshot, 1_000_000); // 1000s later, cooldown elapsed
  assert.equal(firedThird.length, 1);
});
