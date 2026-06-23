---
type: Fixed
pr: 1633
---
**`/gsd:secure-phase` now honors the configured ASVS level and block threshold** — the security auditor previously received unsubstituted `{SECURITY_ASVS}` / `{SECURITY_BLOCK_ON}` placeholder text because secure-phase.md never assigned those variables. It now resolves `workflow.security_asvs_level` and `workflow.security_block_on` from config (`--raw`) before the auditor handoff. (#1625)
