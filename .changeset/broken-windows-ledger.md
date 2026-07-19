---
type: Added
pr: 0
---
**Broken-windows ledger** — `/gsd-ship` now blocks while `.planning/WINDOWS.md` has any `open` entry, and the executor + verifier auto-populate the ledger with stubs, skipped tests, unrun verifies, and unmet truths as they work. Each window can be `waived` only with a recorded reason (auditable) or `fixed` (removed from the blocking set); `/gsd-progress` surfaces the open + waived counts. Backward-compatible: projects with no ledger ship cleanly (open_count starts at 0). Disable enforcement per-project with `gsd config-set windows.enforce false` (tracking continues, gate stays open). (#1950)
