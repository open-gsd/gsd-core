---
type: Fixed
pr: 2324
---
**The context-monitor hook no longer fails Codex's Stop hook** — GSD wires `gsd-context-monitor` to Codex lifecycle events including `Stop`, but the hook emitted a `hookSpecificOutput.additionalContext` envelope that Codex's Stop schema rejects ("hook returned invalid stop hook JSON output") exactly when context was low. The hook now emits that envelope only for context-injection events (PostToolUse / AfterTool) and exits silently for Stop and every other lifecycle event, while its debounce and critical-session bookkeeping still run. (#2289)
