---
type: Fixed
pr: 4877
---
**verify plan-structure stops warning that a logical-OR fallback swallows a failure** — the R4 scan read "||" as a pipe, so the standard "git cat-file -e <sha> || echo missing" ghost-control idiom was flagged as a swallowed failure when "||" is exactly the construct handling it; single pipes (including zsh "|&") still warn. (#4774)
