---
type: Changed
pr: 3131
---

**Re-wired 4 orphaned workflows as flags on parent commands** — six workflows were mis-categorised as "outright deleted dead skills" during the #2790 consolidation; two were caught by prior PRs (#3045, #3038) and four are fixed here. New flags: `/gsd-discuss-phase --assumptions` (surfaces Claude's implementation assumptions before planning), `/gsd-pause-work --report` (generates a post-session summary in `.planning/reports/`), `/gsd-manager --analyze-deps` (scans ROADMAP phases for dependency relationships before parallel execution), `/gsd-import --from-gsd2` (reverse-migrates a GSD-2 `.gsd/` project back to GSD v1 `.planning/` format). Also sweeps 29 stale `/gsd-*` command references across 27 user-facing files (English + 4 locales). Closes #3131.
