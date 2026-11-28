---
type: Fixed
pr: 6885
---
**`/gsd-audit-milestone` now takes each phase's status from `verification.status`** — it used to read the report's own `**Status:** passed | gaps_found` line, so a passed phase whose covered files had changed since still counted its requirements as satisfied, and `human_needed`, `stale`, `unparseable` and `phase_dir_not_found` had no row in the requirements matrix. The audit now asks the owner for every phase of the milestone, archived phases included, and stops when a read fails or refuses a report instead of treating it as no status. The matrix has a row for every status the owner can answer, only `passed` gives satisfied, and under `passed` a `? NEEDS HUMAN` requirement is partial and a `✗ BLOCKED` one unsatisfied. The audit file's `verification_status` lists the same set plus `orphaned`. (#6812)
