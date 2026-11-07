---
type: Fixed
pr: 5893
---
**`phase insert` names the milestone when the phase belongs to another one** — inserting after a phase that lives in a different milestone than the current one reported `Phase N not found in ROADMAP.md`, the same text as a phase missing from the file; the error now names the milestone that holds it and the current one. (#5679)
