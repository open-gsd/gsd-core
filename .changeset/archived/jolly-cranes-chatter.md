---
type: Fixed
pr: 379
---
**Workflow runtime launcher no longer breaks on install paths containing spaces** — workflow bash blocks resolved the runtime via an unquoted shell string variable (`GSD_SDK="node $GSD_TOOLS"`, invoked as `$GSD_SDK query …`), which word-split on paths like `/Volumes/Mini Me/…` and was silently masked into empty `{}` state. Replaced with a single-line, space-safe `gsd_run` shell launcher (quoted path + `"$@"`), propagated once per workflow file from one canonical snippet and enforced by a parity test. The local-`.cjs` / installed-`gsd-tools`-on-PATH fallback (#3668) and the loud not-found error are preserved. Fixes #373.
