---
type: Fixed
pr: 5828
---
**A refused install no longer leaves GSD half-upgraded** — when a destination is an untrusted symlink, the installer now refuses before writing anything, so the previous install stays intact. Set `GSD_ALLOW_SYMLINKED_DEST=1` to install through the symlink. (#5179)
