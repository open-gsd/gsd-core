---
type: Fixed
pr: 2001
---
**Node-test prohibition proofs now require a clean-fixture causation control** — a `node-test` prohibition's fail-first proof no longer accepts a deceptive content-independent negative test (one that reds merely because `GSD_PROHIB_SUBJECT` is *set*, ignoring the subject's content). The `check_clean_fixture` control is now **mandatory** for the `node-test` kind: a descriptor that omits it is un-provable and hard-gates, rather than greening on the violation alone. **Breaking (Hyrum):** a previously-green node-test prohibition with no clean fixture now hard-gates — blast radius is zero in-tree (no `node-test` prohibition ships today). The `lint-rule` kind is unchanged (its subject IS the linted file, no `GSD_PROHIB_SUBJECT` indirection). (#1906)
