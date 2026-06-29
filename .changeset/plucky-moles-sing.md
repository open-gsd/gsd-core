---
type: Changed
pr: 1805
---
**Internal: hook-bus + stateIO adapter seams** — `createHookBus({bus})` (new `src/hook-bus.cts`, `host`/`engine`/`none` — engine is in-process pub/sub, host fail-closed, none silent) + `createStateIO({io})` (new `src/state-io.cts`, `filesystem`/`sandboxed-storage`/`session-log-append` — filesystem delegates to fs, the rest are fail-closed seams) (ADR-1239 Phase C-1 / #1680 AC4). Completes the Phase 3 adapter seam layer; concrete host binding is Phase 5. No user-facing change.

<!-- docs-exempt: internal adapter seams; no user-facing command/flag/config/schema/doc surface -->
