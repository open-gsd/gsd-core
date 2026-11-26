---
type: Fixed
pr: 6716
---
**A surface-pruned install no longer reports the agents `/gsd:surface` removed as missing** — `validate health` (W010) derived the expected agents from the `.gsd-profile` marker alone, but `/gsd:surface` re-stages agents from the surface-resolved skills and deletes the rest, so disabling a cluster or removing skills left W010 listing every pruned agent as missing; it now derives the expected set from `.gsd-surface.json` when one exists, and an unmodified `full` surface still expects every agent. (#6716)
