#!/usr/bin/env bash
# gsd-hook-version: {{GSD_VERSION}}
# gsd-pre-compact.sh — PreCompact hook: save project state before context compaction
# Persists a timestamped STATE.md snapshot so the post-compaction context
# retains key planning continuity. No-op unless state file exists.
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

# Build state snapshot for compaction awareness
STATE_PRESENT="false"
STATE_HEAD=""
if [ -f .planning/STATE.md ]; then
  STATE_PRESENT="true"
  STATE_HEAD=$(head -30 .planning/STATE.md)
fi

# Emit a structured JSON envelope (#2974). additionalContext carries a state
# snapshot for the post-compaction context; state_present lets tests assert on
# the structured contract without grepping the prose.
node -e '
  const [statePresent, stateHead] = process.argv.slice(1);
  const additionalContext = statePresent === "true"
    ? "## Pre-Compaction State Snapshot\n\n" + stateHead + "\n\n" +
      "_State captured before context compaction. Resume from this snapshot._"
    : "## Pre-Compaction Notice\n\nNo STATE.md found — compaction proceeding without state snapshot.";
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreCompact",
      additionalContext,
      state_present: statePresent === "true",
    }
  }));
' "$STATE_PRESENT" "$STATE_HEAD" 2>/dev/null
