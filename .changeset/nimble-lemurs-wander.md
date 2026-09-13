---
type: Fixed
pr: 4691
---
**`gsd capability install` no longer rejects capabilities whose `requires` names a first-party or already-installed capability** — install-time validation was seeded with a candidate-only map, making any non-empty `requires` unsatisfiable; it now sees the full merged registry (first-party + committed overlays + candidate), so requires resolution, cycle and tier checks, and central config-key exclusivity all actually run at install, agreeing with load time. (#3929)
