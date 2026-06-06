---
type: Removed
pr: 175
---
**`CommandRoutingHub` no longer carries dual-runtime selection** — the `mode`, `sdkLoader`, and `SdkDispatchFailed` errorKind are removed. The Hub routes exclusively through CJS handlers. No change to the observable `dispatch()` contract.

<!-- docs-exempt: Hub is an internal seam; the architectural decision is documented comprehensively in ADR-0174 (merged via PR #198 — superseded ADR-0005/0007/0012/3524 as one canonical record for the SDK retirement). Per-phase ADR amendments would create noise; phase-specific docs land in Phase 6 PRs (#193-#196). -->

