---
type: Fixed
pr: 0
---
**The secret-read guard now denies reads hidden in strings that `find`, `xargs` and `watch` re-interpret** — `find -exec sh -c 'cat .env'`, a shell behind a wrapper under `xargs` (`xargs sudo|timeout|env sh -c '…'`), a quoted word such as `@".env"` piped into `xargs` (which removes the quotes before the sub-command sees it), and `watch` (which joins its operands and runs them through `sh -c`) were allowed while `cat .env` was denied; each is now read as the command it becomes, the plain forms stay denied, and non-secret names near the same constructs stay allowed. (#6114)
