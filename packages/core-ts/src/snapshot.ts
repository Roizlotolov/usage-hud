import type { UsageSnapshot } from "./types.js";

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/**
 * Derives context.usedPct from usedTokens/limitTokens when not given directly.
 * Returns undefined when there isn't enough data to compute a percentage —
 * callers must treat that as "omit the segment", never as 0.
 */
export function contextUsedPct(snapshot: UsageSnapshot): number | undefined {
  const ctx = snapshot.context;
  if (!ctx) return undefined;
  if (ctx.usedPct !== undefined) return clampPct(ctx.usedPct);
  if (ctx.usedTokens !== undefined && ctx.limitTokens) {
    return clampPct(Math.round((ctx.usedTokens / ctx.limitTokens) * 100));
  }
  return undefined;
}

/** Derives a quota window's remainingPct from usedPct when not given directly. */
export function windowRemainingPct(window: { usedPct: number; remainingPct?: number }): number {
  if (window.remainingPct !== undefined) return clampPct(window.remainingPct);
  return clampPct(100 - window.usedPct);
}

/** Strips a leading "provider/" prefix from a model id, e.g. "anthropic/claude-opus-4-8" -> "claude-opus-4-8". */
export function shortModelName(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}
