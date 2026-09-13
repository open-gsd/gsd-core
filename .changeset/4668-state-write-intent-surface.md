---
type: Changed
pr: 0
---
<!-- docs-exempt: internal type surface + lint-guard capability only; no user-facing behavior. ADR-4629 section 8.1 Phase-1 scaffolding, enforcement is Required in Phase 2. -->
Internal (ADR-4629 section 8.1, epic #4629 child C1): introduce the `StateWriteIntent` type, extending `StateTransaction`, and a `readModifyWriteStateMd` opaque-transform recognition capability in the STATE.md write-path drift guard. This is the foundation for verified, bounded STATE.md writes. No user-facing behavior changes and no caller is migrated (that is Phase 2 and later).
