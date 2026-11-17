---
type: Fixed
pr: 6276
---
**Kimi CLI and Kimi Code install and uninstall no longer delete or replace a symlinked `config.toml` unasked** — uninstall removed the link of a GSD-only file (leaving the target with the GSD block) or replaced the link with a regular file, and install over a link to a user-owned file replaced the link too, with exit 0 and no notice, whatever `GSD_ALLOW_SYMLINKED_DEST` said. Without the opt-in both now refuse and leave the link and its target untouched, naming the opt-in; with it the managed block is written into or stripped from the link's target, the link is kept and a GSD-only target is emptied rather than unlinked. A dangling link is never replaced or created through, and regular files behave as before. (#5949)
