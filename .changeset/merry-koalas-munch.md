---
type: Fixed
pr: 0
---
**`/gsd-quick`'s Quick Tasks table row can no longer be permanently corrupted by a task description containing a `|`, and a decision title with a second plain-prose colon no longer blocks phase planning.** `quick.md`'s Step 7c now appends the STATE.md row through the schema-backed `quick-tasks-append` CLI (which gained an optional `--status` flag) instead of authoring raw markdown, so the same escaping the reader already enforces is always applied. Separately, `check.decision-coverage-plan` no longer reports `could-not-parse` for a decision whose title legitimately contains a second colon in plain prose — the separator is now the last bare colon before the closing `**`, not the first. (#4736) (#4793)
