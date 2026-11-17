---
type: Fixed
pr: 6274
---
**A local Claude uninstall now removes GSD's hook registrations, statusline entry and permission entries from `.claude/settings.local.json`** — a local install writes them there (#338), but uninstall only ever opened `settings.json` and skipped the cleanup when that file was absent, so after the hook scripts were deleted Claude Code kept invoking commands that no longer existed. Uninstall now cleans the per-scope settings file the install chose and still cleans `settings.json` for installs that predate the routing; user hooks (including ones sharing a group with a GSD hook), user permissions and other keys stay, and an unparseable local settings file is left untouched with a skip notice. (#5952)
