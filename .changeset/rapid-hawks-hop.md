---
type: Fixed
pr: 6311
---
**TDD RED evidence no longer blocks the wave merge** — `tdd.md` told the executor to write the RED record inside the project without naming a place, and an untracked evidence file made `worktree.cleanup-wave` refuse the merge as `worktree_dirty`; the reference now names the self-ignoring `.gsd/tdd-evidence/{phase}-{plan}/` directory and requires confirming it is ignored before the first write. (#5879)
