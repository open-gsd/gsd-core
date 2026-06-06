---
type: Fixed
pr: 694
---
**`/gsd:update` reliably previews release notes again** — promotes the 1.3.x changelog into dated `[1.3.0]`/`[1.3.1]` sections, stops deleting the temp changelog before the human-readable render (no more `(changelog unavailable)`), and adds a release gate that blocks publishing a version whose `CHANGELOG.md` section was never promoted.
