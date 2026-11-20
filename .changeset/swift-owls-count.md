---
type: Fixed
pr: 5424
---
**`/gsd-plan-phase` step 13b reads the plan count from `find-phase` and stops when that read fails** — it read the count with a `// 0` fallback, so a failed `find-phase` lookup wrote `--plans 0` into STATE.md.
