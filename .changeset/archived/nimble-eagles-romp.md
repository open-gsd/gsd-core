---
type: Changed
pr: 611
---
**Update-check cache is now per-package and lineage-validated, and the installer cleans up leftover `get-shit-done-cc` installs** — after migrating from `get-shit-done-cc` to `@opengsd/gsd-core`, a leftover old install in any runtime dir could write a higher `latest` into the shared update cache and cause a permanent false `⬆ /gsd:update`. The cache now uses a per-package filename (`gsd-update-check-<slug>.json`) carrying a `package_name` lineage field that readers validate, so a different package can no longer poison the indicator (multi-runtime visibility preserved). The installer now auto-detects and removes leftover `get-shit-done-cc` artifacts across runtime config dirs on every install; a new `--dry-run` flag previews the cleanup plan without modifying anything. `/gsd:update` clears the cache for all 15 supported runtimes. See the new how-to: docs/cleanup-get-shit-done-cc.md.
