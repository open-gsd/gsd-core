---
type: Fixed
pr: 2235
---
**`commit_docs` no longer silently disables on CRLF `.gitignore` repos** — git check-ignore falsely reports a trailing-slash path (e.g. `.planning/`) as ignored when the .gitignore has CRLF line endings with blank lines. isGitIgnored now strips trailing slashes before querying, so the false positive cannot occur. (#2206)
