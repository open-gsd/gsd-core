---
type: Fixed
pr: 5639
---
**The `command-exit-zero` gate message now keeps the end of a failing command's output** — the error that lands last in stderr/stdout is no longer cut off, and the `command exited N:` / `command timed out after Ns:` prefix still counts toward the 2000-character cap. (#5593)
