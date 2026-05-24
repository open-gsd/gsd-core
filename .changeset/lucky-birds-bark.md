---
type: Removed
pr: 175
---
**`CommandRoutingHub` no longer carries dual-runtime selection** — the `mode`, `sdkLoader`, and `SdkDispatchFailed` errorKind are removed. The Hub routes exclusively through CJS handlers. No change to the observable `dispatch()` contract.
