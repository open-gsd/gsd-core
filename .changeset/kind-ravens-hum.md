---
type: Fixed
pr: 1635
---
**The security audit gate now respects `workflow.security_block_on` severity** — `/gsd:secure-phase` previously blocked phase advancement on *any* open threat regardless of severity, so the documented `security_block_on` threshold had no effect (and the auditor's block vocabulary didn't even match the config enum). Threats now carry a per-threat **Severity** (critical|high|medium|low), and only open threats at or above the configured `security_block_on` severity count toward the blocking gate (`SECURITY.md threats_open`); `none` disables blocking, and a missing/unparseable severity fails closed as critical. (#1626)
