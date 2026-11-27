---
type: Fixed
pr: 6705
---
**`worktree record-agent`/`worktree create` now reject comma-joined `--files`/`--deletions` lists instead of recording them as one bogus path** — `--files "a,b,c"` was whitespace-split into the single path `a,b,c`, recorded ok:true, and silently matched nothing at cleanup-wave scope time; the verbs now fail closed with reason `comma_joined_scope` and a hint naming the whitespace separator, writing nothing. (#6510)
