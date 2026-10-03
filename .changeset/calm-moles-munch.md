---
type: Fixed
pr: 5151
---
<!-- docs-exempt: agent prompt internal gate alignment; no public CLI or docs change -->
**Shared requirements are no longer marked complete prematurely when executing via `/gsd-execute-phase`** — `agents/gsd-executor.md` now gates requirement completion through `requirements.ready-ids` before invoking `requirements.mark-complete`, preventing shared requirement IDs from being marked complete in `REQUIREMENTS.md` before all declaring sibling plans have finished (#4944).
