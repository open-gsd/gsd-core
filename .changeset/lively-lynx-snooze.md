---
type: Fixed
pr: 1918
---
**`/gsd-progress` no longer reports a stale root milestone in workstream mode** — in a multi-workstream project with no active workstream set, `gsd-tools query init.progress` silently fell back to root `.planning/STATE.md` (often stale) and reported it confidently. It now fails safe with an actionable error naming the available workstreams and the `--ws`/`workstream set` fix, so a stale root value is never reported. Flat mode and `--ws <name>` are unchanged. (#1912)
