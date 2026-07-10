---
type: Fixed
pr: 2148
---
**`commit --files` now commits only the declared paths** — `gsd-tools commit --files A B` previously ran a bare `git commit` that absorbed the entire staged index, silently sweeping in unrelated files the caller never named. The commit now appends a pathspec (`-- <paths>`) so only the staged subset of `--files` lands in the commit; the no-`--files` default path is unchanged. Missing tracked files are still skipped (not committed as deletions, #2014), and when all declared files are missing the function short-circuits to `nothing_to_commit` instead of absorbing the index. (#2112)
