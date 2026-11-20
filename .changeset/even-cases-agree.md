---
type: Fixed
pr: 6395
---
**The PATH-export and canonical-path hooks now treat two letter-case spellings of one folder as the same path on macOS** — they compared `fs.realpathSync` results, which keep the caller's letter case on a case-insensitive volume, so one install reached through two spellings wrote two `export PATH=` lines and the plugin bundle self-heal rejected a bundle that was inside the root (and a correct link could read as wrong); both hooks now resolve with `realpathSync.native` on both sides of every comparison, and the symlink-escape checks are unchanged. (#6107)
