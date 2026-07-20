---
type: Added
pr: 2441
---
**Broken-windows ledger** — `/gsd:ship` now blocks (when `workflow.windows_enforce=true`, opt-in) while `.planning/WINDOWS.md` has any `open` entry, and the executor auto-populates the ledger with stubs, skipped tests, and unrun verifies as it works. Each window can be `waived` only with a recorded reason (auditable) or `fixed` (removed from the blocking set); `/gsd:progress` surfaces the open + waived counts. Backward-compatible: projects with no ledger ship cleanly (open_count starts at 0), and enforcement is off by default so tracking can precede the gate. Enable with `gsd config-set workflow.windows_enforce true`. (#1950)
