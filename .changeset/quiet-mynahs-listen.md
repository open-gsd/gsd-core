---
type: Fixed
pr: 5485
---
**The commit-message validation hook no longer stalls on very large commit messages on macOS** — under bash 3.2 in a UTF-8 locale, validating a ~112KB `git commit -m` message took several seconds and could time out the hook; the subject is now extracted byte-wise and it takes a fraction of a second (#5473).
