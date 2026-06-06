---
type: Changed
pr: 727
---
**fish-shell support in the post-install PATH suggestion.** When a directory is not on your PATH, the installer now prints a fish-native `fish_add_path '<dir>'` line alongside the zsh/bash suggestions (the previous `export PATH=…` commands are inert in fish). It also stops the false-positive "not on your PATH" warning for fish users whose `fish_user_paths`/`config.fish` already covers the directory, detected via a read-only probe of fish's config (no fish subprocess, no writes). No change for bash/zsh/PowerShell/cmd/Git-Bash users.
