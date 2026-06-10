---
type: Fixed
pr: 905
---
**`syncStateFrontmatter` no longer strips `current_phase`, `current_phase_name`, `current_plan`, and `progress` from `STATE.md`** — when body annotations are absent (e.g. after an agent rewrites the body), the existing frontmatter values for those scalars are now preserved, mirroring the fallback already applied in `cmdStateJson`. (#905)
