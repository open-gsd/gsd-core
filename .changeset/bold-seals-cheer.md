---
type: Fixed
pr: 0
---
**`phase add`, `phase add-batch` and `phase insert` refuse a STATE milestone with no ROADMAP heading, or one already shipped** — when STATE.md named a milestone (such as v9.9) that ROADMAP.md has no heading for, or one ROADMAP.md marks shipped, these verbs numbered the new phase and wrote its `Depends on` line against the wrong milestones (every unshipped one, or the closed one) and reported success; they now stop before writing anything and name the milestone, quoted and length-capped. A version mentioned in a Phase title, a code fence or an HTML comment no longer counts as a milestone heading. A milestone title such as "Failed Payment Recovery" or "Closed Beta" is no longer treated as shipped, while headings like `v1.0 MVP shipped 2026-01-01` still are. (#5726)
