---
type: Fixed
pr: 6353
---
`capability set --runtime` keeps `gsd-file-manifest.json` in step with the skills it re-stages, so the next install no longer backs up a capability's updated skills to `gsd-local-patches/` as local edits (#6331).
