---
type: Changed
pr: 6702
---
**`roadmap upgrade --convention bracket` now rewrites phase labels in `STATE.md` and `PROJECT.md`** — after a bracket migration those two files no longer say `Phase 3:` for a phase directory that was renamed; each unambiguous label becomes the canonical `[GSD.02] 01:` display. A label whose number exists in more than one milestone is left as written and listed under `crossRefSkipped` in the dry-run plan. (#4751)
