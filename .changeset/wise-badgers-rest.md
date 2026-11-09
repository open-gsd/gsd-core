---
type: Fixed
pr: 5974
---
**Copilot and Codex agents keep their full tool list** — agents that declare `tools:` as a YAML block list (gsd-security-auditor, gsd-nyquist-auditor) were installed with a single mangled entry such as `['- read']` for Copilot or `- Read` for Codex instead of every declared tool. (#5790)
