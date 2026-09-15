---
type: Changed
pr: 4773
---
**Bracket-configured projects now emit canonical bracket phase identifiers on phase and state write paths** — `phase add`, `phase add-batch`, `phase insert`, and `phase remove` route headings, directories, artifact renames, and descriptive state text through the shared phase-ID owner while `null`, `sequential`, and `milestone-prefixed` projects retain their existing output. (#4304)

<!-- docs-exempt: the governing ADR already documents bracket emit and PR-6 owns the generated user-facing convention guidance -->
