---
type: Changed
pr: 824
---
<!-- docs-exempt: internal workflow change to automated codex exec invocations only; the flags affect session isolation and hook-trust behavior in non-interactive CI runs, not any user-facing command, config key, or output format -->
Automated `codex exec` invocations in the review workflow now include `--ephemeral` (no session-state accumulation across automated/CI runs) and `--dangerously-bypass-hook-trust` (skip hook-trust prompts for hooks managed by gsd-core itself). These flags apply only to the non-interactive reviewer invocations in `gsd-core/workflows/review.md`. (#773)
