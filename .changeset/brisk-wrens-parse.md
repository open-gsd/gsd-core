---
type: Security
pr: 5968
---
**The secret-read guard reads seven more shell constructs the way the shell does** — a carriage return before `#` or as a heredoc tag, an escaped backtick in a heredoc body, a `$$` before `{` (also as `\$$` in a backtick body), a `#` inside `$((…))`, a heredoc line joined to the next by a backslash-newline, and zsh's `x (#…` and `{cat .env}` each hid a `cat .env` that bash, dash or zsh runs, and the guard allowed it. A command holding one of them is now also scanned under the shell's reading of it, and denied if any reading finds a read, so no command denied before is allowed now. The readings draw on the guard's one scan budget, so a long command they apply to is scanned more often: a heredoc commit message the guard scanned to the 1,048,576-character limit before can now be denied as too complex (measured, from about 420,000 to 840,000 characters by what its lines hold), and one holding `$'…'` from about 64,500 rather than 70,000. (#5523)
