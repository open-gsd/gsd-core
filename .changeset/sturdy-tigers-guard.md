---
type: Fixed
pr: 6344
---
**The workflow guard now examines every statement of a compound command** — `git add -f` (and other force forms) glued to a shell operator (`echo hi; git add -f secrets.env`) is blocked instead of silently allowed; quoted operators stay within their word.
