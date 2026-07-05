---
type: Added
pr: 2013
---
**`graphify.graph_path` makes the knowledge-graph location configurable so one umbrella graph can serve multiple projects** — a new `.planning/config.json` key (path relative to project root, or absolute) overrides where `/gsd-graphify query|status|diff` read the graph, letting a single curated cross-repo umbrella graph serve every sibling sub-project without N drifting ~5 MB mirror copies. Previously the graph location was hardcoded to `<cwd>/.planning/graphs/` with no override; the only workaround was copying the umbrella `graph.json` into each project (which drifted, wasted disk, and could be silently overwritten by an in-project build). The diff snapshot travels with the configured graph; build stays project-scoped; unset → byte-identical default; a configured-but-missing file yields an actionable error naming the path. (#1825)
