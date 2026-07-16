---
type: Fixed
pr: 0
---
**`/gsd:new-milestone --ws <name>` no longer overwrites the shared PROJECT.md milestone heading** — in workstream mode the shared `.planning/PROJECT.md` had its `## Current Milestone` heading rewritten with one workstream's milestone, so with parallel workstreams whichever ran last silently won the shared heading. Step 4 is now skipped when a workstream is active, and the commit no longer stages PROJECT.md. The `--ws` flag is also now parsed into `${GSD_WS}`, which previously expanded to empty and silently dropped workstream scope from the suggested next commands.
