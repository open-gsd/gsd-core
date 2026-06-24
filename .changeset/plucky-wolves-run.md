---
type: Fixed
pr: 1664
---
**`frontmatter set` on an object-list field now fails closed instead of silently doing nothing** — setting `must_haves` (or another object-list field) to a value whose lossy parse projection matched the original's was a silent no-op: the command reported `{updated:true}` but the change never applied (the writer's scalar-only parser had flattened both to the same shape). `frontmatter set` now detects a no-op write for dict-valued fields and surfaces a clear error directing the user to edit the file directly. Scalars and scalar arrays round-trip faithfully, so idempotent sets of those still report `{updated:true}` (no false positive).
