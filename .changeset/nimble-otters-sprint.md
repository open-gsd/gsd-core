---
type: Fixed
pr: 6248
---
**`/gsd-verify-work` checks each path in a multi-file backtick span on its own** — a claimed-files span like `` `src/a.py src/b.py` `` is now probed per path, so files that exist are no longer reported missing and the check budget is no longer consumed by a joined string that can never resolve.
