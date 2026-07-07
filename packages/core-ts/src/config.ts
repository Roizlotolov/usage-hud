import type { ResolvedUsageHudConfig, UsageHudConfig } from "./types.js";

export const DEFAULT_CONFIG: ResolvedUsageHudConfig = {
  footer: {
    enabled: true,
    template: null,
    fields: ["model", "tokens", "context", "cost"],
  },
  command: {
    enabled: true,
    name: "usage",
  },
  alerts: {
    context: { enabled: true, thresholdPct: 80 },
    budget: { enabled: true, thresholdPct: 20 },
    cooldownSec: 900,
  },
};

/** Merges a partial user config over DEFAULT_CONFIG. Never mutates inputs. */
export function resolveConfig(partial?: UsageHudConfig): ResolvedUsageHudConfig {
  return {
    footer: {
      enabled: partial?.footer?.enabled ?? DEFAULT_CONFIG.footer.enabled,
      template: partial?.footer?.template ?? DEFAULT_CONFIG.footer.template,
      fields: partial?.footer?.fields ?? DEFAULT_CONFIG.footer.fields,
    },
    command: {
      enabled: partial?.command?.enabled ?? DEFAULT_CONFIG.command.enabled,
      name: partial?.command?.name ?? DEFAULT_CONFIG.command.name,
    },
    alerts: {
      context: {
        enabled: partial?.alerts?.context?.enabled ?? DEFAULT_CONFIG.alerts.context.enabled,
        thresholdPct:
          partial?.alerts?.context?.thresholdPct ?? DEFAULT_CONFIG.alerts.context.thresholdPct,
      },
      budget: {
        enabled: partial?.alerts?.budget?.enabled ?? DEFAULT_CONFIG.alerts.budget.enabled,
        thresholdPct:
          partial?.alerts?.budget?.thresholdPct ?? DEFAULT_CONFIG.alerts.budget.thresholdPct,
      },
      cooldownSec: partial?.alerts?.cooldownSec ?? DEFAULT_CONFIG.alerts.cooldownSec,
    },
  };
}
