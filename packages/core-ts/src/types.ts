/**
 * Canonical types shared by every adapter. Mirrors SPEC.md §1-2 exactly —
 * update both together.
 */

export type UsageSnapshot = {
  model: string;

  provider?: string;

  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };

  context?: {
    usedTokens?: number;
    limitTokens?: number;
    usedPct?: number;
  };

  cost?: {
    turnUsd?: number;
    sessionUsd?: number;
  };

  quota?: {
    windows?: Array<{
      label: string;
      usedPct: number;
      remainingPct?: number;
      resetAt?: number;
    }>;
  };

  route?: {
    sessionKey?: string;
    channel?: string;
    agentId?: string;
  };
};

export type FooterField = "model" | "tokens" | "context" | "cost" | "quota";

export type UsageHudConfig = {
  footer?: {
    enabled?: boolean;
    template?: string | null;
    fields?: FooterField[];
  };
  command?: {
    enabled?: boolean;
    name?: string;
  };
  alerts?: {
    context?: {
      enabled?: boolean;
      thresholdPct?: number;
    };
    budget?: {
      enabled?: boolean;
      thresholdPct?: number;
    };
    cooldownSec?: number;
  };
};

export type ResolvedUsageHudConfig = {
  footer: { enabled: boolean; template: string | null; fields: FooterField[] };
  command: { enabled: boolean; name: string };
  alerts: {
    context: { enabled: boolean; thresholdPct: number };
    budget: { enabled: boolean; thresholdPct: number };
    cooldownSec: number;
  };
};

export type AlertKind = "context" | "budget";

export type FiredAlert = {
  kind: AlertKind;
  text: string;
  windowLabel?: string;
};
