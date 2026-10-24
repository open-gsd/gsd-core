---
type: Fixed
pr: 5666
---
**The Codex sandbox posture check no longer skips every role when the nested agents directory holds only a README** — the canonical agent-source directory is now chosen only when it contains a `gsd-<name>.md` agent file, so a stray non-agent markdown file cannot hide the real sources and real sandbox mismatches are reported again. (#5636)
