---
type: Fixed
pr: 5835
---
**`/gsd-code-review --depth=quick` now runs every check it lists** — quick reviews missed secret values containing `-`, `.` or `/`, never flagged `passthru`, and never checked for commented-out code, because the commands it ran had drifted from its own pattern list. (#4101)
