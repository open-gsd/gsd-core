---
type: Fixed
pr: 416
---
`getActiveMilestoneArchiveDir` no longer falls back to the newest archive directory when the active milestone has no archive yet — returns `null` so the verifier no longer reports prior-milestone phases as "active" (eliminates W007 false positives during the flat→archive transition).
