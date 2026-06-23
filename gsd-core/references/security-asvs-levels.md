# Security ASVS Levels

GSD threat modeling maps OWASP ASVS levels to planner disposition rigor and auditor verification depth. Higher levels are supersets of lower — L3 includes all L2 and L1 requirements.

## L1 — Opportunistic (default)

**Scope:** Cover threats on primary trust boundaries and high-impact components.

**Planner disposition:** `mitigate` critical/high-severity threats. `mitigate` medium-severity threats if they occur on a primary trust boundary; otherwise `accept` with documented rationale explaining the specific risk tolerance. `accept` low-risk threats with a rationale statement. `transfer` when threat is third-party responsibility.

**Auditor verification depth:** Verify each declared mitigation is PRESENT in the cited file (grep-level check — find the pattern, confirm the call exists).

## L2 — Standard

**Scope:** Map ALL applicable STRIDE categories for every in-scope component.

**Planner disposition:** `mitigate` medium-severity-and-above threats. Every `accept` MUST have explicit documented rationale explaining why the risk is tolerable for this specific context.

**Auditor verification depth:** Verify the mitigation ACTUALLY ADDRESSES the threat vector (not just that some pattern is present) and is placed at the correct trust boundary. A login check in the wrong layer does not close the threat.

## L3 — Comprehensive

**Scope:** Exhaustive STRIDE × all components; defense-in-depth for critical threats.

**Planner disposition:** `mitigate` all threats except those explicitly accepted with documented sign-off. Defense-in-depth layers required for critical threats (multiple independent controls).

**Auditor verification depth:** Deep verification — trace data flow end-to-end, check edge cases and ordering, confirm the mitigation cannot be bypassed via alternate code paths or parameter manipulation.
