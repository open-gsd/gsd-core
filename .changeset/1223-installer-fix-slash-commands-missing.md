---
type: Fixed
pr: 0
---
**gsd-tools no longer crashes at load on a fresh install** — the installer omitted `scripts/fix-slash-commands.cjs`, which `command-roster` requires at module load, so every `gsd-tools` command failed with MODULE_NOT_FOUND. The installer now ships it (with a smoke assertion), and `readCmdNames()` tolerates a missing commands directory. (#1223)
