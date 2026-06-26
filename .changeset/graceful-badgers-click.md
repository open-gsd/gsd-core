---
type: Fixed
pr: 1765
---
Phase headers that place a parenthetical tag before the colon (`### Phase 26 (Cluster B): Title`) now resolve and enumerate the same as untagged headers. Previously the resolver returned not-found and `roadmap analyze`/listing silently dropped the phase (wrong phase_count, progress, and next_phase). Tag tolerance is applied at every phase-header read site; untagged and all existing header formats parse unchanged.
