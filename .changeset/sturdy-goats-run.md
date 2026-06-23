---
type: Fixed
pr: 1630
---
**`/gsd-*` commands in Windsurf Cascade resolve their command bodies** — Windsurf slash-command workflows delegate to canonical command bodies at gsd-core/commands/gsd/X.md, but the install never copied those files. Commands appeared in the `/` menu yet silently failed when invoked because the LLM was told to read a missing file. Installs now copy commands/gsd/*.md into the workflow delegation target.
