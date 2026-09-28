---
type: Fixed
pr: 0
---
**Fixed skills/*/SKILL.md still telling agents to run a bare `gsd-tools` command** — on a shim-only install (no global `gsd-tools` on PATH), following gsd-workstreams, gsd-quick, gsd-review-backlog, or gsd-config's SKILL.md instructions verbatim failed with `command not found`; the generated skill now uses the same `gsd_run` resolver every other shipped skill/workflow already relies on. (#4995)
