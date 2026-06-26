---
type: Security
pr: 1725
---
**Installer writes are now confined to the declared config home** — the workflow/skill emit path (`copyWithPathReplacement`) and the Codex config writer (`installCodexConfig`) now reject any destination that escapes the install root: crafted or absolute paths, path-separator agent names, and pre-existing symlinks are refused before any delete or write. Fail-closed: an install write with no declared root is rejected rather than written unconfined.
