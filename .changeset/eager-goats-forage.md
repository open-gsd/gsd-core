---
type: Fixed
pr: 953
---
**`/gsd-update` no longer flags `managed-hooks-registry.cjs` as a custom file** — the shipped hook is now recorded in the file manifest, eliminating a perpetual false-positive custom-file warning.
