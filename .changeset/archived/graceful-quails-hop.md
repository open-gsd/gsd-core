---
type: Fixed
pr: 598
---
**`gsd-phase-researcher` no longer fails to write `RESEARCH.md` on OpenCode** — large research files that previously hit `JSON parsing failed: Expected '}'` and a retry doom-loop now write reliably. The agent keeps its single-write default and falls back to incremental section-by-section writes only when a runtime truncates an oversized tool call.
