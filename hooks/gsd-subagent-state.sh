#!/usr/bin/env bash
# gsd-hook-version: {{GSD_VERSION}}
# gsd-subagent-state.sh — SubagentStop hook: log subagent lifecycle completion
# Emits a structured notice when a sub-agent finishes so the orchestrating
# context sees a clear handoff marker. No-op unless community hooks are enabled.
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

INPUT=$(cat)

# Extract subagent name from JSON payload using Node
SUBAGENT_NAME=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const p=JSON.parse(d);process.stdout.write(p.subagent_name||p.agent_name||'unknown')}catch{process.stdout.write('unknown')}})" 2>/dev/null)

# Emit a structured JSON envelope. additionalContext carries a handoff notice;
# subagent_name lets tests assert on the structured contract.
node -e '
  const name = process.argv[1] || "unknown";
  const additionalContext = "Sub-agent completed: " + name + "\n" +
    "Review sub-agent output and decide whether to continue or adjust the plan.";
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SubagentStop",
      additionalContext,
      subagent_name: name,
    }
  }));
' "$SUBAGENT_NAME" 2>/dev/null
