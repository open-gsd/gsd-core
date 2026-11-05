---
type: Fixed
pr: 5914
---
**`/gsd-new-milestone --reset-phase-numbers` no longer archives the root project's phase folders from inside a named project or workstream** — the reset fence in `reset-phase-safety.md` moved the literal `.planning/phases` and then checked that same folder, so under `GSD_PROJECT` or `--ws` it moved the root project's phase directories and left the scoped ones in place. It now moves and checks `${phases_dir}`; flat projects are unchanged. (#5860)
