---
type: Fixed
pr: 1636
---
**`workflow.security_asvs_level` now actually scales security rigor** — it was display-only (the planner hardcoded ASVS L1 and the auditor only echoed the level), so L2/L3 behaved identically to L1. The configured ASVS level now scales both planner threat-disposition rigor and auditor verification depth (L1 grep-presence → L2 boundary/vector checks → L3 end-to-end trace), defined in a new `references/security-asvs-levels.md`; the secure-phase clean-phase short-circuit now spawns the auditor at L2/L3 so deep verification runs even when the preliminary grep classification is clean. (#1627)
