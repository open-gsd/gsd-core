---
type: Changed
pr: 721
---
**The installer now speaks fish** — the post-install "not on your PATH" guidance includes a copy-paste-correct `fish_add_path` line, and the warning is suppressed when fish already covers the directory via `fish_user_paths` or `config.fish`. Previously fish users were handed inert `export PATH=…` commands and a false-positive warning on every install (#323).
