---
type: Fixed
pr: 4723
---
**Commits are no longer blocked when a project configures a large `commit_types` list** — the commit validator built one regular expression out of every configured type, and on macOS (bash 3.2 / BSD libc) that pattern stopped compiling past roughly 6,000 types. The validator reported the compile failure as "this message is not a Conventional Commit" — rejecting a valid `feat(auth): …` while listing `feat` among the valid types it printed. At the same payload the hook could also abort outright with a broken-pipe error instead of returning a verdict. Linux (glibc) has no comparable limit and was never affected by this half. Both paths are fixed and now covered by regression tests. (#4429)
