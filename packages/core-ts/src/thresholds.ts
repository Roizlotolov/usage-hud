import type { FiredAlert, ResolvedUsageHudConfig, UsageSnapshot } from "./types.js";
import { contextUsedPct, windowRemainingPct } from "./snapshot.js";

function cooldownKey(sessionKey: string | undefined, kind: string, sub: string): string {
  return `${sessionKey ?? ""}:${kind}:${sub}`;
}

/**
 * Evaluates threshold crossings for one snapshot and tracks per-(session, kind,
 * window) cooldown state in memory, per SPEC.md §4. One instance per adapter
 * process is enough — cooldown state does not need to survive a restart.
 */
export class AlertEngine {
  private readonly config: ResolvedUsageHudConfig;
  private readonly lastFiredAtMs = new Map<string, number>();

  constructor(config: ResolvedUsageHudConfig) {
    this.config = config;
  }

  private isInCooldown(key: string, nowMs: number): boolean {
    const last = this.lastFiredAtMs.get(key);
    return last !== undefined && nowMs - last < this.config.alerts.cooldownSec * 1000;
  }

  private markFired(key: string, nowMs: number): void {
    this.lastFiredAtMs.set(key, nowMs);
  }

  /**
   * Snapshots cooldown state for persistence. Needed by adapters that run as
   * a short-lived process per invocation (e.g. a Claude Code statusline
   * script) rather than a long-running gateway - an in-memory Map alone would
   * reset on every single invocation and never actually cool down.
   */
  getState(): Record<string, number> {
    return Object.fromEntries(this.lastFiredAtMs);
  }

  /** Restores cooldown state saved by getState(). Merges into any existing state. */
  loadState(state: Record<string, number>): void {
    for (const [key, atMs] of Object.entries(state)) {
      this.lastFiredAtMs.set(key, atMs);
    }
  }

  evaluate(snapshot: UsageSnapshot, nowMs: number = Date.now()): FiredAlert[] {
    const fired: FiredAlert[] = [];
    const sessionKey = snapshot.route?.sessionKey;

    const ctxConfig = this.config.alerts.context;
    if (ctxConfig.enabled) {
      const pct = contextUsedPct(snapshot);
      if (pct !== undefined && pct >= ctxConfig.thresholdPct) {
        const key = cooldownKey(sessionKey, "context", "context");
        if (!this.isInCooldown(key, nowMs)) {
          this.markFired(key, nowMs);
          fired.push({
            kind: "context",
            text: `⚠️ Context alert: context window at ${pct}% (≥ ${ctxConfig.thresholdPct}%)`,
          });
        }
      }
    }

    const budgetConfig = this.config.alerts.budget;
    if (budgetConfig.enabled) {
      for (const window of snapshot.quota?.windows ?? []) {
        const remainingPct = windowRemainingPct(window);
        if (remainingPct <= budgetConfig.thresholdPct) {
          const key = cooldownKey(sessionKey, "budget", window.label);
          if (!this.isInCooldown(key, nowMs)) {
            this.markFired(key, nowMs);
            fired.push({
              kind: "budget",
              windowLabel: window.label,
              text: `⚠️ Budget alert: ${window.label} at ${remainingPct}% left (≤ ${budgetConfig.thresholdPct}%)`,
            });
          }
        }
      }
    }

    return fired;
  }
}
