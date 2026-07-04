---
type: Fixed
pr: 1846
---
**Autonomous reruns now skip phases with deferred verification until you resume them explicitly** — if a prior `/gsd-autonomous` run recorded `verification_deferred_human` or `verification_deferred_gaps`, later reruns no longer drop back into the same prompt loop and instead point you at the saved resume command. (#1846)
