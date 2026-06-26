---
type: Changed
pr: 1719
---
**#853 dispatch-flatten is now data-driven (ADR-1239 Phase B)** — whether GSD backgrounds the plan/execute orchestrator is decided from a documentation-sourced `backgroundDispatch` capability per host (via `gsd_run query dispatch-should-flatten`) instead of a hardcoded `runtime === 'codex'` check. **Cursor now backgrounds the orchestrator** (its docs document backgrounded subagent nesting); codex unchanged; all other hosts run inline. Fail-closed to inline on any uncertainty.
