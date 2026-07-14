---
type: Changed
pr: 2251
---
**`requirements mark-complete` reports a per-surface write-set** — the command now returns a per-requirement `write_set` (checkbox + traceability surfaces) and a `write_set_complete` that is true only when every surface of every requirement applied, so a partial (checkbox-only) reconcile can no longer masquerade as full success even inside a multi-ID batch. Introduces the reusable ADR-2143 §5/§6 `Result` / `WriteSet` contract. (#2251)
