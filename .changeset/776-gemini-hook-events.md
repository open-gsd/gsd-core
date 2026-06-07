---
type: Added
pr: 829
---
Gemini installs now register three additional hook events — `BeforeAgent`, `AfterAgent`, and `BeforeModel` — wired to `gsd-context-monitor.js` for per-turn context headroom tracking. Previously only `SessionStart`, `BeforeTool`, and `AfterTool` were registered. The installer also detects `hooksConfig.enabled: false` in the user's Gemini `settings.json` and emits a clear warning, surfacing the silent failure mode where all hooks are registered but never execute. (#776)
