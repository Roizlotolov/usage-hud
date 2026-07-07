import type { FooterField, ResolvedUsageHudConfig, UsageSnapshot } from "./types.js";
import { contextUsedPct, shortModelName, windowRemainingPct } from "./snapshot.js";

function tokensSegment(snapshot: UsageSnapshot): string | undefined {
  const t = snapshot.tokens;
  if (!t || (t.input === undefined && t.output === undefined)) return undefined;
  const base = `in ${t.input ?? 0}/out ${t.output ?? 0}`;
  return t.cacheRead ? `${base} (cache ${t.cacheRead})` : base;
}

function contextSegment(snapshot: UsageSnapshot): string | undefined {
  const pct = contextUsedPct(snapshot);
  return pct === undefined ? undefined : `ctx ${pct}%`;
}

function costSegment(snapshot: UsageSnapshot): string | undefined {
  const turnUsd = snapshot.cost?.turnUsd;
  return turnUsd === undefined ? undefined : `$${turnUsd.toFixed(4)}`;
}

function quotaSegment(snapshot: UsageSnapshot): string | undefined {
  const windows = snapshot.quota?.windows;
  if (!windows || windows.length === 0) return undefined;
  return windows.map((w) => `${w.label} ${windowRemainingPct(w)}% left`).join(", ");
}

const SEGMENT_BUILDERS: Record<FooterField, (s: UsageSnapshot) => string | undefined> = {
  model: (s) => shortModelName(s.model),
  tokens: tokensSegment,
  context: contextSegment,
  cost: costSegment,
  quota: quotaSegment,
};

/**
 * Renders the passive footer appended to an outbound reply.
 * Returns "" when footer is disabled or there's nothing to show.
 */
export function formatFooter(snapshot: UsageSnapshot, config: ResolvedUsageHudConfig): string {
  if (!config.footer.enabled) return "";
  const segments = config.footer.fields
    .map((field) => SEGMENT_BUILDERS[field](snapshot))
    .filter((s): s is string => s !== undefined);
  if (segments.length === 0) return "";
  return `\n\n— ${segments.join(" · ")}`;
}

/** Renders the on-demand /usage reply — one labeled line per available field. */
export function formatOnDemand(snapshot: UsageSnapshot): string {
  const lines: string[] = [`Model: ${shortModelName(snapshot.model)}`];

  const t = snapshot.tokens;
  if (t && (t.input !== undefined || t.output !== undefined)) {
    const base = `Tokens: in ${t.input ?? 0} / out ${t.output ?? 0}`;
    lines.push(t.cacheRead ? `${base} (cache ${t.cacheRead})` : base);
  }

  const pct = contextUsedPct(snapshot);
  if (pct !== undefined) {
    const ctx = snapshot.context!;
    lines.push(`Context: ${pct}% (${ctx.usedTokens ?? "?"} / ${ctx.limitTokens ?? "?"})`);
  }

  const cost = snapshot.cost;
  if (cost?.turnUsd !== undefined) {
    const turn = `$${cost.turnUsd.toFixed(4)} this turn`;
    lines.push(
      cost.sessionUsd !== undefined ? `Cost: ${turn} ($${cost.sessionUsd.toFixed(2)} session)` : `Cost: ${turn}`,
    );
  }

  const q = quotaSegment(snapshot);
  if (q !== undefined) lines.push(`Quota: ${q}`);

  return lines.join("\n");
}
