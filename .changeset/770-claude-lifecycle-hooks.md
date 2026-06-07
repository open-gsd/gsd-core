---
type: Added
pr: 821
---

Added: register newly-available Claude Code lifecycle hooks — SubagentStop, Stop, PreCompact (all wired to gsd-context-monitor for context-headroom warnings), and FileChanged (matcher: `config.json`, wired to new gsd-config-reload.js hook that hot-reloads `.planning/config.json` context mid-session). Also updates hooks/hooks.json (plugin manifest) and managed-hooks-registry for drift-guard coverage (#770).
