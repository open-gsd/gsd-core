---
type: Fixed
pr: 6675
---
**`audit-open` no longer hides every open seed when one seed has a bare `status:` or `title:` line, and `list-seeds` reads CRLF seeds** — a bare `status:` made the whole seeds category collapse into one scan error and report zero seeds, a bare `title:` put a raw object into the JSON, and a seed saved with CRLF line endings listed as `dormant` in `list-seeds` while `audit-open` already read its real status. (#4647)
