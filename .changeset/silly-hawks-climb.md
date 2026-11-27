---
type: Fixed
pr: 6674
---
**Report refused requirement statuses separately from missing IDs** — when `requirements mark-complete` cannot advance a matching Status cell, the JSON report lists it under `status_refused` instead of misreporting the requirement as missing.
