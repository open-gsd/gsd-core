---
type: Added
pr: 5091
---
**`/gsd-execute-phase` can deliver executor procedure files and the sequential root-pin guard by path (`workflow.dispatch_embed: "path"`)** — instead of copying ~115 KB of procedure text and the bound guard into every dispatch prompt, the orchestrator lists the files by absolute path for the executor to Read in full, writes the bound guard once per run to the git dir (a minimal `<project_root_pin>` block still names it, so older executors keep running a bound guard), and asks for a fixed short completion reply. The guard file fails closed when missing, unbound, or run from another checkout. The default `"inline"` keeps today's prompts. (#5080)
