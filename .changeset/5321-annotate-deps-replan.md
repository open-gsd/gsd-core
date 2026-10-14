---
type: Fixed
pr: 52
---
**`roadmap.annotate-dependencies` now rewrites an existing wave annotation when a replan changes the waves** — the command used to return early once a phase's Plans block carried `**Wave N**` headers or a cross-cutting constraints block, so ROADMAP.md kept the old grouping and could contradict a plan's `depends_on`. It now rebuilds the block from the plans' current `wave` frontmatter; an unchanged re-run still writes nothing and returns `updated: false`.
