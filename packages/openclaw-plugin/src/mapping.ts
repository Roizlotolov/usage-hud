import type { UsageSnapshot } from "@usage-hud/core";
import type { PluginHookReplyPayloadSendingEvent } from "openclaw/plugin-sdk/core";

type PluginHookReplyUsageState = NonNullable<PluginHookReplyPayloadSendingEvent["usageState"]>;

/**
 * Maps OpenClaw's PluginHookReplyUsageState onto the canonical UsageSnapshot.
 * contextUsedTokens is end-of-turn occupancy (not the multi-call aggregate) -
 * exactly what SPEC.md requires for context.usedTokens. `usage` is already the
 * turn aggregate OpenClaw computed; we never re-derive it.
 */
export function snapshotFromUsageState(
  usageState: PluginHookReplyUsageState,
  route: { sessionKey?: string; channel?: string } = {},
): UsageSnapshot | undefined {
  if (!usageState.model) return undefined;

  const snapshot: UsageSnapshot = { model: usageState.model };

  if (usageState.provider) snapshot.provider = usageState.provider;

  if (usageState.usage) {
    snapshot.tokens = {
      input: usageState.usage.input,
      output: usageState.usage.output,
      cacheRead: usageState.usage.cacheRead,
      cacheWrite: usageState.usage.cacheWrite,
      total: usageState.usage.total,
    };
  }

  if (usageState.contextUsedTokens !== undefined || usageState.contextTokenBudget !== undefined) {
    snapshot.context = {
      usedTokens: usageState.contextUsedTokens,
      limitTokens: usageState.contextTokenBudget,
    };
  }

  if (usageState.turnUsd !== undefined) {
    snapshot.cost = { turnUsd: usageState.turnUsd };
  }

  if (route.sessionKey || route.channel || usageState.agentId) {
    snapshot.route = {
      sessionKey: route.sessionKey,
      channel: route.channel,
      agentId: usageState.agentId,
    };
  }

  return snapshot;
}
