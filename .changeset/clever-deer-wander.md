---
type: Fixed
pr: 640
---
**`gsd-tools query summary-extract` no longer drops snake_case `requirements_completed`** — the reader now accepts both the kebab `requirements-completed` and the snake `requirements_completed` key forms (the snake form is what the tool's own JSON output and the milestone audit `--pick` emit), so a round-tripped requirements field is no longer silently read back as empty.
