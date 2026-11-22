---
type: Fixed
pr: 0
---
**The Bash secret-read guard denies `gh api -F body=@.env` and httpie `data=@.env` request items** — `gh api -F/--field key=@path` and httpie's `key=@path`, `key:=@path`, `key==@path`, `Header:@path` and `key@path` items open the named file and send its contents, but the guard only read curl's whole-word `@file` form, so each was allowed; when the resolved command is `gh api` or `http`/`https` the path after `@` is now tested, while `-f`/`--raw-field`, `@-` and commands that merely mention `http` or `gh api` stay allowed. (#5825)
