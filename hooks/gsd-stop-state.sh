#!/usr/bin/env bash
# gsd-hook-version: {{GSD_VERSION}}
# gsd-stop-state.sh — Stop hook: emit session-end summary
# Outputs the final phase and task status when Claude finishes responding,
# for use as a handoff marker in multi-session workflows.
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

# Capture current mode and state for the summary
CONFIG_MODE="unknown"
if [ -f .planning/config.json ]; then
  CONFIG_MODE=$(node -e "try{const c=require('./.planning/config.json');process.stdout.write(String(c.mode||'unknown'))}catch{process.stdout.write('unknown')}" 2>/dev/null)
fi

STATE_HEAD=""
if [ -f .planning/STATE.md ]; then
  STATE_HEAD=$(head -5 .planning/STATE.md)
fi

# Emit a structured JSON envelope. additionalContext carries a handoff summary;
# config_mode lets tests assert on the structured contract.
node -e '
  const [configMode, stateHead] = process.argv.slice(1);
  const stateSnippet = stateHead ? "\n\n" + stateHead : "";
  const additionalContext = "## Session Stop\n\nMode: " + configMode + stateSnippet;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext,
      config_mode: configMode,
    }
  }));
' "$CONFIG_MODE" "$STATE_HEAD" 2>/dev/null
