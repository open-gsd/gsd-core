---
type: Changed
pr: 604
---

**Installer migration 003 removes stale legacy runtime directory files on upgrade** — the installed runtime config subdirectory was renamed from `~/.claude/get-shit-done/` to `~/.claude/gsd-core/` in #604. <!-- gsd-allow-legacy-name -->
Installer migration `2026-06-02-rename-get-shit-done-to-gsd-core` now removes managed files from the stale legacy directory once `gsd-core/` is confirmed present, preserving any user-added files under the old path. Emptied subdirectory shells may remain on disk (the migration framework operates per-file, not per-directory). The npm package name and binary entrypoints are unchanged.
