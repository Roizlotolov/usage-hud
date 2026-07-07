# Source this (or add to ~/.hermes/.env) before running the Hermes gateway.
# PluginContext has no config-passing mechanism (verified against source) -
# this is the real, working config pattern, same as the bundled Langfuse
# observability plugin. See packages/hermes-plugin/README.md.

export USAGE_HUD_FOOTER_ENABLED=true
export USAGE_HUD_FOOTER_FIELDS="model,tokens,context,cost"
export USAGE_HUD_COMMAND_ENABLED=true
export USAGE_HUD_COMMAND_NAME=cost          # /usage, /status, /footer, /compress are Hermes built-ins

export USAGE_HUD_ALERT_CONTEXT_ENABLED=true
export USAGE_HUD_ALERT_CONTEXT_THRESHOLD_PCT=80
export USAGE_HUD_ALERT_BUDGET_ENABLED=true
export USAGE_HUD_ALERT_BUDGET_THRESHOLD_PCT=20
export USAGE_HUD_ALERT_COOLDOWN_SEC=900
