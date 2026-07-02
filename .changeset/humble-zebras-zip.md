---
type: Fixed
pr: 1919
---
**`phases clear` archives phase directories instead of destroying them** — at a milestone switch, committed phase directories were hard-deleted (`rmSync`) with no archive, silently losing browsable phase history (the #1447 dirty-tree guard was a no-op for the common committed case). Phase directories are now moved to `milestones/<version>-phases/` (collision-safe; timestamp fallback when no version resolves), so history survives the switch. The #1447 uncommitted-changes guard is retained as a secondary backstop. (#1871)
