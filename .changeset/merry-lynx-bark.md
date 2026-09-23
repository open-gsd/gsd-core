---
type: Changed
pr: 4935
---
<!-- docs-exempt: internal verifying-executor capability only; no caller migrated and no user-facing behavior. ADR-4629 section 8.2/8.3 Phase-2 step, same posture as C1 (#4676). -->
Internal (ADR-4629 section 8.2 and 8.3, epic #4629 child C2): add the verifying executor for STATE.md writes. A declared StateWriteIntent is applied through the existing write seam and fails loud when a required assertion does not land or the write changes anything outside its declared scope. No user-facing behavior changes and no caller is migrated (that is Phase 3 and later).
