---
type: Fixed
pr: 338
---
`--claude --local` installs now write hook wiring to `.claude/settings.local.json` (Claude Code's per-user slot) instead of the repo-shared `.claude/settings.json` — engineer-specific absolute paths no longer leak into the shared settings file. Includes a one-shot migration of prior local-install entries on re-run.
