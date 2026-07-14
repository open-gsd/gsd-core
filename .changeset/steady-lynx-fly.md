---
type: Fixed
pr: 2253
---
**Roadmap, requirements, and state table edits are confined to the right table** — the last ad-hoc table writers (phase completion updating roadmap progress, `requirements mark-complete`, and `state record-metric`/velocity) now route through the shared markdown-table seam, so a stray decoy table elsewhere in a document can no longer swallow a phase-progress update, a single ragged neighbouring row no longer silently aborts the whole edit, and per-plan metric recording no longer drops trailing section content or duplicates the section. (#2253)
