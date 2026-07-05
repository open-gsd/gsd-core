---
type: Fixed
pr: 1992
---
**OpenCode reviewer no longer silently yields an empty review on large prompts** — `/gsd-review --opencode` now invokes `opencode run --format json` and reconstructs the review from the assistant text parts, so a large-prompt run where the default `build` agent ends its turn with zero output tokens no longer produces an empty stub. When the agent genuinely emits no text, the stub now reports the stop reason, output-token count, and captured stderr instead of a generic message. (#1936)
