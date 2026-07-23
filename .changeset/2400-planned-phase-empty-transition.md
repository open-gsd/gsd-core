---
type: Fixed
pr: 0
---
**`state.planned-phase` now warns on no-op transitions and syncs `progress.total_plans`** — when STATE.md's Current Position has no recognized labels (narrative prose), the command emits a `warning` field so the workflow can detect the no-op instead of continuing with stale state. When a plan count is provided, `progress.total_plans` in the YAML frontmatter is updated alongside the body `Total Plans in Phase` field, preventing contradictory state between the two representations. Previously, the command silently returned success with an empty `updated` array and zero bytes written, and left `progress.total_plans` at 0 while the body reported the actual count. (#2400)
