---
type: Fixed
pr: 5642
---
**A first install no longer silently replaces a user skill that shares a shipped GSD skill's name** — the first-time baseline scan reported such a file as "preserved" while the install overwrote it. The replaced file is now copied to `gsd-local-patches/` (listed in `backup-meta.json`), and the report says it was replaced and where the copy is. (#5522)
