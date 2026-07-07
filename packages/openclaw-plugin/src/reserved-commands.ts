/**
 * Core command names OpenClaw reserves for built-ins (verified against
 * openclaw@2026.6.11's command-registration source). Third-party plugins
 * cannot register these; `registerCommand` rejects them at validation time.
 * We check locally too so a misconfigured `command.name` degrades to the
 * default instead of silently failing plugin registration.
 */
export const OPENCLAW_RESERVED_COMMANDS = new Set([
  "help", "commands", "status", "diagnostics", "codex", "whoami", "context",
  "btw", "stop", "restart", "reset", "new", "compact", "config", "debug",
  "allowlist", "activation", "skill", "subagents", "kill", "steer", "tell",
  "model", "models", "queue", "send", "bash", "exec", "think", "verbose",
  "reasoning", "elevated", "usage",
]);

export const DEFAULT_COMMAND_NAME = "quota";
