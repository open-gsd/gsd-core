---
type: Added
pr: 0
---
**Planning documents are now read and written through one parse → mutate → serialize seam** — a new internal `PlanningDoc` layer composes the existing markdown-sectionizer, markdown-table and frontmatter seams so a verb can no longer bring its own regex to a `.planning/` artifact. A field write reaches only its own value token, leaving hand-written prose on the same line intact by construction; serialization splices into the original buffer, so untouched regions stay byte-identical; and a write refuses outright on a document containing any region the parser could not read. No command changes behavior yet — this phase adds the seam and migrates no call site. (#4906)
