---
type: Security
pr: 6377
---
**MCP `gsd_read_state` and `gsd_write_state` can no longer read or write files outside the project `.planning/` root** — a client could pass an absolute path, a `..` path or a symbolic link and read or write any file the server process could reach (#6146). Both tools, and the filesystem state-IO adapter behind them, now refuse relative paths, paths that leave `.planning/` (including through a dangling or symlinked component or a symlinked `.planning`) and hard-linked files, with an error naming the `.planning/` root; `createStateIO({ io: 'filesystem' })` now needs `{ root }` and fails closed without it.
