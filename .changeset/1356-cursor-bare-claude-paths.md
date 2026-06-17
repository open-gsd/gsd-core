---
type: Fixed
pr: 1368
---

**`gsd install --cursor` no longer leaves bare `~/.claude` paths in installed artifacts** — the Cursor install branch only rewrote the trailing-slash `.claude` forms, so bare `~/.claude` / `$HOME/.claude` references survived into installed skills and workflows (e.g. `gsd-surface`, `gsd-graphify`, `plan-phase`, `autonomous`) and tripped the post-install "unreplaced .claude path reference(s)" warning, pointing at a directory that doesn't exist on a Cursor-only install. The Cursor branch now rewrites bare forms too (mirroring the Trae/Augment/Copilot branches), using a `(?![\w-])` lookahead so `.claude-plugin` / `.claudeignore` are not corrupted. (#1356)
