---
type: Fixed
pr: 1916
---
**workstream progress no longer reports shipped milestones as `executing`** — `gsd-tools workstream progress` now derives each workstream's status from authoritative shipped signals (an archived milestone snapshot under milestones/, or a SHIPPED marker in the workstream ROADMAP) instead of trusting the mutable STATE.md `Status` field, so a stale field can never hide a shipped/archived milestone. The output adds `status_source` (`field` | `derived`) and `status_conflict` (true when the derived value disagrees with the stale field). (#1913)
