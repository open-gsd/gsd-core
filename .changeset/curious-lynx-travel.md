---
type: Fixed
pr: 635
---
**`/gsd-plan-phase` gap-analysis no longer reports the tool as "not found" on non-default installs** — the post-planning-gaps step now resolves `gsd-tools` through the workflow's `gsd_run` launcher instead of a hardcoded `$HOME/.claude/...` path, so it works under relocated/global installs and non-Claude runtimes instead of silently falling back to a frontmatter-only coverage check.
