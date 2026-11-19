---
type: Fixed
pr: 6275
---
**Cline global uninstall no longer deletes or rewrites a symlinked `~/.agents/AGENTS.md` unasked** — a dotfiles-managed link holding only the GSD block was removed (leaving the target untouched) and a mixed one was edited through the link, with no regard for `GSD_ALLOW_SYMLINKED_DEST`, all with exit 0 and no notice. Without the opt-in the uninstall now leaves the link and its target alone and says it skipped the file; with it the link is kept, a mixed file loses only the GSD block and a GSD-only target is emptied rather than deleted. Regular files behave as before, and the symlink helpers introduced for Copilot are shared rather than duplicated. (#5947)
