---
type: Fixed
pr: 0
---
**Windsurf uninstall and reinstall keep a symlinked `hooks.json`** — uninstall deleted the link and a reinstall with changes replaced it with a plain file, leaving GSD's hook entries in the file it pointed at, whatever `GSD_ALLOW_SYMLINKED_DEST` said; now a symlinked `hooks.json` is refused (nothing removed or changed) unless the opt-in is set, and with it the file the link points at is edited and the link stays. (#5978)
