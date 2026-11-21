---
type: Fixed
pr: 0
---
**`init` and `agent-skills` no longer crash under a runtime id GSD does not resolve** — since 1.16.0 every `init` command exited 1 with `UnknownRuntimeError` (and `agent-skills` too, even with no skills configured) on any host whose runtime id is not first-party, such as an out-of-tree host plugin, so GSD could not start there; the agents check now reports `agents_installed: null` with `agents_check_reason: "unknown_runtime"` instead of throwing, `agent-skills` resolves its skills location only when there are skill entries, the W010 health rule and the new-project and new-milestone warnings treat `null` as not-checkable, and installing under an unknown id still refuses. (#5236)
