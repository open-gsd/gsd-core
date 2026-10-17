---
type: Fixed
pr: 5423
---
**`roadmap.annotate-dependencies` now rewrites an existing wave annotation when a replan changes the waves** — the command used to return early once a phase's Plans block carried `**Wave N**` headers or a cross-cutting constraints block, so ROADMAP.md kept the old grouping and could contradict a plan's `depends_on`. It now rebuilds the block from the plans' current `wave` frontmatter; an unchanged re-run still writes nothing and returns `updated: false`. Generated constraint headings now carry an invisible `<!-- gsd:generated -->` marker; a pre-existing block without it is rebuilt but keeps every bullet that is not a current shared constraint, so a reworded constraint can leave its old bullet behind to delete by hand. A Plans list split by an unrecognised checklist row (`- [  ]`, `* [ ]`) or an empty wave header is left untouched: stderr warns and the JSON carries `skipped: "unrecognised_checklist_row"`.
