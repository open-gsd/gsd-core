---
type: Added
pr: 803
---
Elevate the Cline runtime to hook parity. The installer now emits the Cline `.clinerules/` directory form (`.clinerules/gsd.md`) instead of a single `.clinerules` file, adds a `.clinerules/hooks/PreToolUse` lifecycle hook (Cline v3.36+ JSON stdin → `{cancel,errorMessage,contextModification}` protocol; guards `.planning/` artifacts and fails open), and merges GSD instructions into the cross-tool global `~/.agents/AGENTS.md` target on global installs. A legacy single-file `.clinerules` is migrated to the directory form in place, and `--uninstall` removes the new artifacts and strips the GSD block from `~/.agents/AGENTS.md`. (#787)
