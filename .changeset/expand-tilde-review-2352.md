---
type: Fixed
pr: 2419
---
**`/code-review` no longer skips a phase whose SUMMARY.md records `~/`-prefixed file paths** — such a path was silently dropped as "deleted" (bash never tilde-expands a `~` that arrives as a variable's value), emptying the review scope and reporting "no source files changed" as a false success. Tilde paths are now expanded to `$HOME/…` before the deleted-file filter runs.
