---
type: Changed
pr: 5847
---
**The project-root walk stops at a symlinked `$HOME` in either spelling** — with `$HOME` a symlink, a cwd spelled through its target (what `process.cwd()` reports), or the reverse, walked past `$HOME` and could take a `.planning/` above it as the project; a cwd at `$HOME` itself with no `.planning/` walked above it with any spelling. Both now stop at `$HOME`, and the isolation hooks, which resolve through the same walk, agree. (#5624)
