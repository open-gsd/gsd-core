---
type: Fixed
pr: 5300
---
**Installs, updates and uninstalls no longer replace a symlinked `settings.json` with a plain file** — without `GSD_ALLOW_SYMLINKED_DEST` they stop with a message naming it, and with it the write goes through to the link's target. Uninstall also leaves alone a Codex `hooks.json` with no GSD hooks in it, instead of rewriting it into the nested `hooks` layout as before. (#5037)
