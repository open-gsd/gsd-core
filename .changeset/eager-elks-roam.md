---
type: Fixed
pr: 0
---
**The debugger-spawn guard no longer slows down on commands padded with repeated `timeout` wrappers** — a 1 MiB command of leading `timeout 1 ` words took seconds to tens of seconds to check (quadratic), long enough for OpenCode and Kilo to kill the hook and treat it as an allow; the check is now linear. (#5628)
