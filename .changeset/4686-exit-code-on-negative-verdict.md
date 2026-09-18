---
type: Fixed
pr: 4791
---
phase uat-passed and query verify.artifacts now exit 1 when their computed verdict is negative, instead of printing passed:false / all_passed:false and exiting 0. ADR-3889 defines the 0/1 band as unversioned — 0 means the operation ran and its verdict is affirmative, 1 means it ran and the verdict is negative — but neither verb ever declared its verdict to the exit-contract seam, so a $? / set -e / && caller could not tell a failed gate from a passed one. The JSON verdict payloads are unchanged; the precondition error arms (missing plan/phase) keep their existing exit behavior. The loop-QA result classifier gains a verdict-fail kind so a scenario step can still assert on a failing verdict's payload.
