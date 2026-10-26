---
type: Fixed
pr: 5713
---
**A symlinked Codex `config.toml` is written through, not replaced, when `GSD_ALLOW_SYMLINKED_DEST=1` is set** — the install merged the GSD agent block into a fresh plain file and left the dotfiles copy the link points at untouched, then reported success. Now the merge and the final schema-validated rewrite both land in the link target and the link stays; without the opt-in the install still refuses. (#5301)
