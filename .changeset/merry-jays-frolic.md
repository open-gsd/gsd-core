---
type: Fixed
pr: 4919
---
**`state record-session` reports the record it replaces** — overwriting a prior Stopped At or Resume File handoff now names the displaced text in the verb's payload instead of succeeding silently, and the executor decision loop passes --phase so decisions stop inheriting whichever phase the global pointer names. (#4763)
