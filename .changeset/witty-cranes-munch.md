---
type: Fixed
pr: 5005
---
**`state add-decision --summary-file` / `--rationale-file`, `add-blocker --text-file` and `add-roadmap-evolution --note-file` now accept any readable file**, including a scratch file outside the project root; a file that cannot be read now exits non-zero with the reason on stderr (`reason: "usage"` under `--json-errors`) instead of printing `{ "added": false }` at exit 0. (#4926)
