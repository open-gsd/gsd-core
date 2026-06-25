---
type: Added
pr: 1692
---
**GSD now warns when model config changed without re-running the installer on static-frontmatter runtimes** — on `codex` and `opencode`, editing `model_overrides` or `model_profile_overrides` or `model_policy.runtime_tiers` in `.planning/config.json` or `~/.gsd/defaults.json` previously had no effect until the user re-ran `gsd install <runtime>`, and the failure was silent: the sub-agent kept using the base model. Workflow entry points like `gsd-tools init *` now emit a one-line stderr warning naming the changed config file and the exact remediation command when they detect the config is newer than the baked agent files. The guard is read-only and warning-only by default, dedup'd per session, and skipped entirely on Claude Code because Claude Code resolves models at spawn time. Resolves #1688 as the structural follow-up to #1650.
