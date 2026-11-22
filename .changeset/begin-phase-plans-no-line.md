---
type: Fixed
pr: 6516
---
**`state begin-phase --plans N` refuses instead of silently dropping the count** — on a STATE.md with no `Total Plans in Phase:` field and no `Plan:` line in `## Current Position`, the command wrote Status and Last Activity, recorded no plan count and exited 0, so the caller believed the count had landed (the frontmatter kept `total_plans: 0`); it now exits non-zero with the typed reason `plans_no_line` before any write, and behaves as before when either place can hold the count or `--plans` is not given. (#6399)
