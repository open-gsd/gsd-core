---
type: Fixed
pr: 5314
---
**`state add-decision --summary-file` / `--rationale-file`, `add-blocker --text-file` and `add-roadmap-evolution --note-file` now accept any readable regular file of up to 256 KiB**, including a scratch file outside the project root. Every refusal from these three verbs now exits non-zero with the reason on stderr (`reason: "usage"` under `--json-errors`): a file that cannot be read, a FIFO, device or directory, a file over 256 KiB, a blank (empty or whitespace-only) required field given inline or as a file, or a missing STATE.md. A blank rationale, inline or file, is written as no rationale. Before, they printed `{ "added": false }` or `{ "error": … }` at exit 0. (#4926)
