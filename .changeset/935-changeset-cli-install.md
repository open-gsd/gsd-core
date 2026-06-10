---
type: Fixed
pr: 935
---
**`/gsd-update` changelog preview no longer silently fails** — the installer now copies `scripts/changeset/` and `scripts/lib/` into the runtime config dir so `$GSD_DIR/scripts/changeset/cli.cjs` resolves at runtime; `update.md` was updated to use the correct installed path and to surface an explicit error if the CLI is missing rather than swallowing it.
