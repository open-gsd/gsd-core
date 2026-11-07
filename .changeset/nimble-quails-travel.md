---
type: Fixed
pr: 5915
---
**`/gsd-new-milestone` and `/gsd-new-project` under a workstream or a named project now write and commit that scope's roadmap files, not the root project's** — the roadmapper armed the write guard for the root `.planning/ROADMAP.md` and `STATE.md`, so the scoped roadmap Write was blocked (or, on a new project, a 15-minute unlock for the root `ROADMAP.md` was left on disk), and the workflows never told it where to write. The roadmapper and revise spawns now pass the init-resolved ROADMAP.md, STATE.md and REQUIREMENTS.md paths in a `<write_targets>` block, the roadmapper arms the guard only for those paths, `init new-project` reports `state_path`, and `/gsd-new-project` commits the scoped ROADMAP.md and STATE.md. The research synthesizer and the #222 self-heal now follow the research directory init reports (`research_dir`) instead of a literal `.planning/research/`, and `verify-summary` accepts that absolute path. (#5859)
