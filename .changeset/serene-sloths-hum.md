---
type: Added
pr: 5717
---
**Repository-scoped release tags: `milestone release-tags` preflights and creates annotated tags per sub-repo** — a new `gsd-tools milestone release-tags --map <file.json> [--dry-run]` verb validates every requested repository, ref and tag before writing, never overwrites an existing tag, reports which tags were already created on a partial failure, and never pushes. (#3628)
