---
type: Fixed
pr: 4599
---
**`restore-custom-files` no longer re-offers a file that is already byte-identical to its backup** — such an entry is reported as `already_present`, excluded from `eligible_count` and `restored_count`, and never rewritten under `--apply`, so the update workflow's restore prompt settles after one successful restore instead of asking again on every update. (#4558)
