---
type: Fixed
pr: 6190
---
**`audit-open` no longer aborts on one archived `VERIFICATION.md` with an out-of-set status** — an archived milestone report whose `status:` is `resolved`, `verified`, `failed`, `pass_with_caveats` or anything else outside the closed set made `audit-open` exit 1 and blocked `/gsd-complete-milestone`'s pre-close audit; it is now reported as one `verification_gaps` item (archived milestone, file, raw status) that can be acknowledged, and the scan continues. Reports under the active `.planning/phases` keep the hard refusal. (#6172)
