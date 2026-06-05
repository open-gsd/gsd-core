---
type: Added
pr: 178
---
**`DispatchEvent` now propagates `parentTraceId` (#178)** — every `DispatchEvent` already carries a `traceId` (P1.3). `Hub.dispatch(req)` now accepts an optional `req.parentTraceId`; when present, it appears on the emitted event. This is the seam through which a future init-composer (Phase 2) will correlate child dispatches with their parent. Backward compatible — leaf dispatches that don't set `parentTraceId` emit events with `parentTraceId: undefined` exactly as in P1.3.
