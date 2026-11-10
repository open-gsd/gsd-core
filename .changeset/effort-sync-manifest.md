---
type: Fixed
pr: 5899
---

**`effort sync --apply` no longer makes the next install back up synced agents as local patches** — the sync rewrote agent files without updating gsd-file-manifest.json, so the next install treated every synced agent as a local modification; the manifest now records the synced files. (#5683)
