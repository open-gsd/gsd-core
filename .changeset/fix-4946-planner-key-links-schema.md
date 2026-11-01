---
type: Fixed
pr: 5149
---
<!-- docs-exempt: shared planner prompt guidance only; no public CLI or documentation change -->
**Planners no longer put symbols or endpoints in key-link file fields that fail `verify key-links`** — The shared planner guidance now states that `from:` and `to:` must be project-relative file paths, with symbols and endpoints in `via:`. The planner already loads this guidance while authoring key links (#4946).
