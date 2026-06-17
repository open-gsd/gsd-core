---
type: Fixed
pr: 1354
---

**Update backups now ignore preserved shared skills and hooks** -- `/gsd-update` custom-file detection now mirrors installer cleanup scope for shared runtime roots, so non-`gsd-*` skills and hooks are not copied into backup folders unnecessarily. (#1325)
