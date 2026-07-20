---
type: Fixed
pr: 2466
---
**`/gsd-next` no longer reports a project as complete while phases are still unchecked** — `smart-entry`'s completion check now grounds in ROADMAP.md's actual Progress table (global, authoritative) instead of STATE.md's stale milestone-scoped total_phases, and its status regex requires milestone-level language (`milestone complete` / `all phases complete` / `complete`) instead of matching any per-phase `shipped` or `done` substring. Together these fix the false-complete misclassification that could route `/gsd-next` toward `/gsd-new-milestone` — which archives still-pending phase directories.
