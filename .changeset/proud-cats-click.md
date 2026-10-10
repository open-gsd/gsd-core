---
type: Fixed
pr: 0
---
**Installs and updates no longer replace a symlinked `settings.json` with a plain file**: the settings writer now follows the `GSD_ALLOW_SYMLINKED_DEST` policy the Codex `hooks.json` writer uses. Without the opt-in, a symlinked settings file stops the install with a message naming it; with it, the write goes to the link's target and the link stays in place. A settings link whose target is missing is refused either way rather than replaced. Before, every install or update silently swapped a dotfiles-managed link for a plain file, so later settings changes never reached the dotfiles copy. (#5037)
