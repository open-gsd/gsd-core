---
type: Fixed
pr: 5300
---
**Installs and updates no longer replace a symlinked `settings.json` with a plain file** — without `GSD_ALLOW_SYMLINKED_DEST` the install stops with a message naming it, and with it the write goes through to the link's target. (#5037)
