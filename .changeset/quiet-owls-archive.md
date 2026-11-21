---
type: Fixed
pr: 6459
---
**`phases clear` messages and the CLI reference say the phase directories are archived, not deleted** — the `--confirm` gate and the uncommitted-changes guard told operators the command would "delete" or "permanently delete" phase directories, and the CLI reference said `--force` deletes, when the command only ever moves them into `milestones/<version>-phases/`; the guard now says `--force` archives uncommitted edits with the directory. (#5270)
