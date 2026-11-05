---
type: Fixed
pr: 5914
---
**`init.new-project` and `init.new-milestone` now resolve research and milestone history inside a named project or workstream** — under `GSD_PROJECT`, `research_dir` named the root `.planning/research`, and under `GSD_PROJECT` or `--ws` the `latest_completed_milestone` and `phase_archive_path` fields read the root `MILESTONES.md`, so a scoped run read the root project's research and archived phases into the root's milestone. Workstreams still share the project's `research/`. (#5858)
