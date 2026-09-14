---
type: Fixed
pr: 0
---
**Commits are no longer blocked when a project configures a large `commit_types` list** — past roughly 6,000 configured types the commit validator built a regular expression bigger than bash can compile, and it reported the compile failure as "this message is not a Conventional Commit" — rejecting a valid `feat(auth): …` while listing `feat` among the valid types it printed. At the same payload the hook could also abort outright with a broken-pipe error instead of returning a verdict. Both paths are fixed and now covered by regression tests. (#4429)
