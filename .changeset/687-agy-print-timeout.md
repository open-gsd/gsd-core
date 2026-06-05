---
type: Fixed
pr: 689
---
**`/gsd-review --agy` no longer hangs the whole review on large prompts.** On a big, file-path-rich prompt Antigravity's `agy -p` agentic Cascade can loop on its `code_search`/grep steps and never converge. The invocation now passes agy's own `--print-timeout` flag (its native print-mode cap) so a stalled run self-terminates through the tool's own mechanism; on a non-zero exit any partial output is discarded so the existing transcript fallback / "review failed" stub take over.
