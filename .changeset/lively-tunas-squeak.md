---
type: Changed
pr: 1444
---
Installer PATH suggestion now supports fish: it offers a fish-native `fish_add_path` command and no longer prints a spurious "not on your PATH" warning when fish's fish_user_paths / config.fish already covers the npm global bin (#323).
