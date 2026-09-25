---
type: Fixed
pr: 4986
---
**`/gsd-undo` no longer reverts a commit that merely mentions a phase or plan number in prose, no longer misses under `--phase` a breaking-change commit that `--plan` would catch, and no longer silently drops a `fixup!`/`squash!`/`Revert` wrapper's work from a phase revert** — commit-scope selection now reads git history structurally and validates the target id up front, instead of grepping raw commit text with an unanchored pattern. `init`/`milestone`'s phase-heading scanners now recognize bracket-convention headings the same way `roadmap` already does, instead of silently undercounting phases in a bracket-convention project. `pr-branch` no longer treats a nested `<milestone>-phases/` directory as structural planning state, and no longer halts on a spurious cherry-pick conflict when a later commit reuses a path an earlier excluded commit also touched. (#4865) (#4661) (#4605) (#4606)
