---
type: Fixed
pr: 4835
---
**Resuming a phase whose verification did not pass no longer claims it is verified** — `execute-phase`'s resume ladder branched on "is the report missing", so `gaps_found`, `human_needed` and `unknown` all took the route written for a passed verdict whose roadmap write never happened: the run reported the phase as verified, skipped re-verification, and continued at the roadmap update, where the completion gate then refused the non-passed verdict. Those three statuses now get their own resume arm that presents `verification status`'s own next action and next command and stops. The `passed`, `missing` and `stale` routes are unchanged. (#4765)
