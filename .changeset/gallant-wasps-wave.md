---
type: Fixed
pr: 1832
---
state prune now resolves the current phase from the canonical location — frontmatter current_phase, the Current Phase field, or the prose Phase: line scoped to the ## Current Position section — instead of extracting Phase over the whole document, where stateExtractField's pipe-table fallback could latch onto an unrelated | Phase | N | row (e.g. a historical verification table) and compute a wrong prune cutoff.
