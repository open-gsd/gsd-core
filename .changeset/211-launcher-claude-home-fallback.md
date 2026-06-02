---
type: Fixed
pr: 211
---
`gsd_run` workflow launcher now also probes `$HOME/.claude/gsd-core/bin/gsd-tools.cjs` — global Claude-Code installs (`--claude` without `--local`) with no PATH wiring or `RUNTIME_DIR` are no longer rejected by the resolver. Closes #394 (duplicate).
