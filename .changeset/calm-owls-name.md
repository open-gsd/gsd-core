---
type: Fixed
pr: 5596
---
**`state planned-phase` without `--name` no longer writes `READY TO EXECUTE` as the phase name** — a STATE.md with no curated `current_phase_name` gained that status text as the name, and with a curated name the body `Phase:` line dropped it so body and frontmatter disagreed. The prose parser now treats the planned-phase status phrase as a status, and the nameless label reuses the curated name. (#5369)
