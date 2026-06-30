---
type: Changed
pr: 1738
---
**Honest verifier — verify-phase now abstains on non-inferable `backstop` truths instead of confidently false-passing them (#1154).** When the spec's edge-probe marks a truth non-inferable (`verification: backstop`) and the verifier cannot confirm it with explicit evidence (a passing wired held-out/property test, or a directly-observed behavior), it now reports `human_needed` with reason `insufficient_spec` ("unverified — held-out test recommended") rather than a silent `passed`. Autonomous runs complete with "N unverified non-inferable checks"; interactive runs route to the end-of-phase human checkpoint. Inferable truths are never abstained (over-abstention guard); abstention is exogenous (driven by the tag, not self-judgment). Truth-axis mirror of the prohibition judgment-tier (ADR-550 D4).
