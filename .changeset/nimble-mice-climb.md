---
type: Fixed
pr: 1299
---
**Config docs/prompts now match the consumers** — `workflow.subagent_timeout` is documented in milliseconds (default 300000), not "seconds (default 600)" (a user who entered 600 got a 600 ms timeout); `review.models.<cli>` is documented as a bare model id injected into `--model`/`-m`, not a shell command; and `workflow.test_command` / `workflow.build_command` (consumed by verify-phase, execute-phase, audit-fix, and the post-merge gate) are now accepted by `config set` and documented. (#1296)
