---
type: Fixed
pr: 5958
---
**Installs, updates and uninstalls no longer replace a symlinked `settings.json` with a plain file** — without `GSD_ALLOW_SYMLINKED_DEST` they stop with an error instead, and with it the write goes through to the link's target; a local Claude install treats a symlinked `settings.local.json` the same way, and an OpenCode uninstall no longer deletes a symlinked `settings.json`. With the opt-in, an uninstall or the #338 migration over a link whose target directory is read-only stops before changing anything. (#5037, #5948)
