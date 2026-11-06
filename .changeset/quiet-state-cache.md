---
type: Fixed
pr: 5550
---
**`.planning/state.json` no longer leaves the tree dirty, so `/gsd-ship` stops refusing on it** — the derived cache was rewritten at every boundary command but never committed or ignored. A new project commits a `/state.json` rule in `.planning/.gitignore`; the first boundary command in a project that already tracks the file untracks it once (staged, file kept, idempotent) and the next `commit` carries the removal; each clone's `.git/info/exclude` is the fallback, and nothing is touched when `commit_docs` is false or a repo only encloses the project; the git probes on this path stop after 5 s, so a hung git cannot stall a boundary command, and `/gsd-health` reports a copy GSD could not untrack as warning `W031`; **`commit --files` skips an ignored, untracked `state.json` instead of failing** — it is reported in `skipped_files` and the rest still commits, where `staging_failed` aborted the commit. (#5505)
