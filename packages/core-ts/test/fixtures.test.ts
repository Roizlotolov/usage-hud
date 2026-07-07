import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolveConfig } from "../src/config.js";
import { formatFooter, formatOnDemand } from "../src/format.js";
import { AlertEngine } from "../src/thresholds.js";
import type { UsageSnapshot, UsageHudConfig, FiredAlert } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/test -> dist -> core-ts -> packages -> repo root
const fixturesDir = path.resolve(here, "..", "..", "..", "..", "spec", "fixtures");

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8"));
}

function readText(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

const allFiles = readdirSync(fixturesDir);
const inputFiles = allFiles.filter((f) => f.endsWith(".json") && !f.endsWith(".expected.json"));

for (const file of inputFiles) {
  const base = file.replace(/\.json$/, "");
  const fixture = readJson(file) as {
    snapshot?: UsageSnapshot;
    config?: UsageHudConfig;
    sequence?: Array<{ nowMs: number; snapshot: UsageSnapshot }>;
  };

  if (base.startsWith("footer-")) {
    test(`footer: ${base}`, () => {
      const config = resolveConfig(fixture.config);
      const actual = formatFooter(fixture.snapshot!, config);
      const expected = readText(`${base}.expected.txt`);
      assert.equal(actual, expected);
    });
  } else if (base.startsWith("on-demand-")) {
    test(`on-demand: ${base}`, () => {
      const actual = formatOnDemand(fixture.snapshot!);
      const expected = readText(`${base}.expected.txt`);
      assert.equal(actual, expected);
    });
  } else if (base === "alert-cooldown-sequence") {
    test(`alert: ${base}`, () => {
      const config = resolveConfig(fixture.config);
      const engine = new AlertEngine(config);
      const actual = fixture.sequence!.map((step) => engine.evaluate(step.snapshot, step.nowMs));
      const expected = readJson(`${base}.expected.json`) as FiredAlert[][];
      assert.deepEqual(actual, expected);
    });
  } else if (base.startsWith("alert-")) {
    test(`alert: ${base}`, () => {
      const config = resolveConfig(fixture.config);
      const engine = new AlertEngine(config);
      const actual = engine.evaluate(fixture.snapshot!);
      const expected = readJson(`${base}.expected.json`) as FiredAlert[];
      assert.deepEqual(actual, expected);
    });
  }
}
