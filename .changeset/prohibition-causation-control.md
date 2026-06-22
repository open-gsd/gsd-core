---
type: Changed
pr: 1518
---
**verify-phase test-tier prohibition fail-first can now prove the RED is caused by the violation's _content_** — the `node-test` machine-proof (#1279) confirmed a known-bad subject drives the negative test RED, but could not tell a genuine content-violation from a deceptive test that reds merely because `GSD_PROHIB_SUBJECT` is set. An optional fifth flat scalar `check_clean_fixture` (→ `CheckDescriptor.cleanFixture`) threads a KNOWN-CLEAN control subject through `projectProhibitions` + `descriptorFromProjection`; when present the prover also runs the check against it and requires GREEN, so fail-first is proven only when the check is RED on the violation **and** GREEN on the clean subject (content-dependent). It is opt-in and additive: absent a clean fixture the prover behaves exactly as it did post-#1314 (no control, documented residual), preserving the zero-authoring compose path; the lint-rule kind needs no analog. (#1346)
