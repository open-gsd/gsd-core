---
type: Fixed
pr: 5149
---
<!-- docs-exempt: prompt guidance and reference table alignment; no public CLI or docs change -->
**Fixed planner prompt lacking schema guidance for `must_haves.key_links`** — `agents/gsd-planner.md` and `gsd-core/references/planner-guidance.md` now explicitly state that `from:` and `to:` must be project-relative file paths only, with symbols and endpoints placed in `via:`, preventing generated plans from failing `verify key-links`. (#4946)
