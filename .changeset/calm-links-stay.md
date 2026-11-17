---
type: Fixed
pr: 6268
---
**Copilot uninstall and install no longer unlink or write through a symlinked `AGENTS.md` or `copilot-instructions.md` unasked** — a dotfiles-managed link holding only the GSD block was deleted (leaving the target untouched), and a mixed one was edited through the link, with no regard for `GSD_ALLOW_SYMLINKED_DEST`. Without the opt-in both uninstall and the install merge now refuse before any change and say how to opt in; with it the link is kept, a mixed file loses only the GSD block and a GSD-only target is emptied rather than deleted. Regular files behave as before. (#5946)
