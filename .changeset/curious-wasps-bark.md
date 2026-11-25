---
type: Changed
pr: 5282
---
**`/gsd-new-milestone` research step now covers the existing codebase** — the Step 8 prompt includes integration points and pitfalls in the existing code, `(Recommended)` is bound to `research_enabled`, and a research dimension may be skipped only with a visible `Skipping:` notice (the synthesizer reads only the research files written in that run; earlier research files in `.planning/research/` are cleared before the researchers run, and only when the spawn actually goes ahead).
