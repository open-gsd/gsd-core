---
type: Fixed
pr: 2026
---
**`planning-config.md` global-learnings path corrected to `~/.gsd/knowledge/`** — the `features.global_learnings` row directed users to `~/.gsd/learnings/`, but the implementation (`src/learnings.cts`, `execute-phase.md`) stores and reads global learnings from `~/.gsd/knowledge/`. Anyone following the docs to inspect, back up, or seed their global learnings looked in a directory the code never touches. (#2019)
