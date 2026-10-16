---
type: Fixed
pr: 5448
---
The shared-requirement-ID gate in execute-plan now reads requirements.ready-ids as JSON, so a finishing plan marks its ready requirement IDs complete instead of silently marking none (#4956).
