---
type: Fixed
pr: 0
---
**Non-Claude installs no longer brand all GSD output as Claude** — the installer never persisted `runtime: <id>` into `~/.gsd/defaults.json` for non-Claude runtimes, so `resolveRuntime()` (precedence: `GSD_RUNTIME` env > `config.runtime` > `'claude'`) fell through to the hard-coded `'claude'` default. A Cursor (or Codex/OpenCode/Windsurf/etc.) install showed `agent_runtime: "claude"` and Claude-formatted `/gsd-*` slash hints with no env or config hand-set. The installer now persists `runtime: <runtime>` into `~/.gsd/defaults.json` for non-Claude runtimes, mirroring the existing `resolve_model_ids: "omit"` write at the same call site. Claude is the fallback so it needs no write; an explicit pre-existing `runtime` value is always preserved. (#2395)
