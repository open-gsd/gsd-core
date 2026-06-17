---
type: Fixed
pr: 1386
---
**Decision-coverage gate now reads markdown-header and em-dash decisions, and fails loud when it can't parse them** — `check.decision-coverage-plan` (a blocking gate) and `gap-analysis` previously extracted **zero** decisions from a populated CONTEXT.md that recorded its decisions under markdown headers (`## Locked decisions`) or with em-dash bullets (`- **D-1 — title**`), and silently reported a clean pass — so real decisions went un-checked. Decisions in those shapes are now recognized, and when decision-shaped content cannot be parsed (or a `- **D-NN**` bullet is malformed), the gate fails loud with a format-mismatch message instead of passing. (#1386)
