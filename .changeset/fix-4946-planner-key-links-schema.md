---
type: Fixed
pr: 5149
---
<!-- docs-exempt: prompt guidance and reference table alignment; no public CLI or docs change -->
**Planners emitted symbols or endpoints in from:/to:, failing `verify key-links`** — `agents/gsd-planner.md` and `gsd-core/references/planner-guidance.md` now explicitly specify that `from:` and `to:` must be project-relative file paths only, with symbols and endpoints placed in `via:` (#4946).
