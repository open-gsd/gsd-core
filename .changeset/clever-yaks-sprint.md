---
type: Fixed
pr: 952
---
**`state patch` and `state record-session` no longer corrupt STATE.md** — a no-match patch no longer rewrites the file (was resetting `milestone_name` and resurrecting a stale `stopped_at`), and `record-session` now persists `--stopped-at`/`--resume-file` even when the body lacks the exact labels.
