---
type: Fixed
pr: 1362
---
**The `map-codebase` and `docs-update` workflows no longer collect background sub-agent results with the deprecated Claude Code `TaskOutput` tool** — they keep `run_in_background=true` on the spawn and `Read` each agent's `outputFile` (from the `async_launched` result) once it reports completion, removing the `TaskOutput(block=true)` main-session hang surface (anthropics/claude-code#20236). Completion-marker contracts and on-disk verification are unchanged, and the non-Claude runtime fallbacks are preserved.
