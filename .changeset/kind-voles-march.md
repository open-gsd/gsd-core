---
type: Added
pr: 2490
---
**Reviewer CLIs now honor GSD's configured reasoning effort instead of silently inheriting your global CLI default** — cross-AI review runs previously picked up whatever `effort` sat in your own `~/.codex`/Claude/OpenCode config, so the same project produced 1-3 minute review cycles on one machine and 12-15+ minute cycles on another with no in-project way to influence it. GSD now resolves one effort value from the `effort.*` cascade and passes it to each reviewer in that CLI's own syntax; a host with no documented reasoning setting is left untouched rather than given a guessed flag. (#2481)
