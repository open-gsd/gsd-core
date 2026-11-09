---
type: Fixed
pr: 5828
---
**A refused install no longer leaves GSD half-upgraded** — when a runtime's install destination is an untrusted symlink, that runtime's install now refuses before writing anything, so its previous install stays intact. In a command that installs several runtimes, runtimes installed before the refusal stay installed. Set `GSD_ALLOW_SYMLINKED_DEST=1` to install through the symlink. (#5179)
