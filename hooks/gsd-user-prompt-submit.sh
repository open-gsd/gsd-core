#!/usr/bin/env bash
# gsd-hook-version: {{GSD_VERSION}}
# gsd-user-prompt-submit.sh — UserPromptSubmit hook: advisory context injection
# Adds a brief project-context reminder when the user submits a prompt, so
# Claude retains orientation across long sessions. Advisory-only — never blocks.
#
# OPT-IN: This hook is a no-op unless config.json has hooks.community: true.
# Enable with: "hooks": { "community": true } in .planning/config.json

# Check opt-in config — exit silently if not enabled
if [ -f .planning/config.json ]; then
  ENABLED=$(node -e "try{const c=require('./.planning/config.json');process.stdout.write(c.hooks?.community===true?'1':'0')}catch{process.stdout.write('0')}" 2>/dev/null)
  if [ "$ENABLED" != "1" ]; then exit 0; fi
else
  exit 0
fi

# Capture current mode for context
CONFIG_MODE="unknown"
if [ -f .planning/config.json ]; then
  CONFIG_MODE=$(node -e "try{const c=require('./.planning/config.json');process.stdout.write(String(c.mode||'unknown'))}catch{process.stdout.write('unknown')}" 2>/dev/null)
fi

# Emit a structured JSON envelope. additionalContext carries a context reminder;
# config_mode lets tests assert on the structured contract without grepping prose.
node -e '
  const configMode = process.argv[1] || "unknown";
  const additionalContext = configMode !== "unknown"
    ? "GSD mode: " + configMode + " — run /gsd-progress or /gsd-phase for current status."
    : "";
  if (!additionalContext) { process.exit(0); }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
      config_mode: configMode,
    }
  }));
' "$CONFIG_MODE" 2>/dev/null
