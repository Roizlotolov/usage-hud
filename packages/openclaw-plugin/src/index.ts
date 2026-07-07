import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AlertEngine, formatFooter, formatOnDemand, resolveConfig, type UsageHudConfig } from "@usage-hud/core";
import { snapshotFromUsageState } from "./mapping.js";
import { DEFAULT_COMMAND_NAME, OPENCLAW_RESERVED_COMMANDS } from "./reserved-commands.js";

const PLUGIN_ID = "usage-hud";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Usage HUD",
  description: "Surfaces existing usage/context/cost into chat: footer, /quota, and same-reply alerts.",
  register(api) {
    const config = resolveConfig(api.pluginConfig as UsageHudConfig | undefined);
    const alertEngine = new AlertEngine(config);

    // api.runtime.state is bundled-plugin-only on this OpenClaw release, so a
    // third-party plugin keeps this cache in process memory. It resets on
    // gateway restart, same as the AlertEngine's cooldown state.
    const lastSnapshotBySession = new Map<string, ReturnType<typeof snapshotFromUsageState>>();

    let commandName = config.command.name;
    if (OPENCLAW_RESERVED_COMMANDS.has(commandName)) {
      api.logger.warn(
        `usage-hud: command.name "${commandName}" is reserved by OpenClaw core; falling back to "${DEFAULT_COMMAND_NAME}"`,
      );
      commandName = DEFAULT_COMMAND_NAME;
    }

    api.on("reply_payload_sending", (event) => {
      if (!event.usageState) return; // durable/replay delivery - no per-turn usage to report
      const snapshot = snapshotFromUsageState(event.usageState, {
        sessionKey: event.sessionKey,
        channel: event.channel,
      });
      if (!snapshot) return;

      if (event.sessionKey) lastSnapshotBySession.set(event.sessionKey, snapshot);

      let appended = "";
      const firedAlerts = alertEngine.evaluate(snapshot);
      if (firedAlerts.length > 0) {
        appended += "\n\n" + firedAlerts.map((a) => a.text).join("\n");
      }
      if (config.footer.enabled) {
        appended += formatFooter(snapshot, config);
      }
      if (!appended) return;

      return { payload: { ...event.payload, text: (event.payload.text ?? "") + appended } };
    });

    if (config.command.enabled) {
      api.registerCommand({
        name: commandName,
        description: "Show current model usage, context, cost, and any pending alerts",
        acceptsArgs: false,
        handler(ctx) {
          const snapshot = ctx.sessionKey ? lastSnapshotBySession.get(ctx.sessionKey) : undefined;
          return {
            text: snapshot ? formatOnDemand(snapshot) : "No usage data yet - send a message first.",
          };
        },
      });
    }
  },
});
