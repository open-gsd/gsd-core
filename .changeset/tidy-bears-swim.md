---
type: Fixed
pr: 2131
---
**`milestone complete` no longer corrupts the recorded phase** — closing a milestone (e.g. `v0.5`) previously overwrote `current_phase` in STATE.md with the version's minor digit, and a follow-up `state complete-phase` mined a bogus `0.5` token and rewrote the file; phase resolution is now anchored so the real phase is preserved and a milestone-closure line is rejected. (#2111)
