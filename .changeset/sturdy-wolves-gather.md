---
type: Fixed
pr: 2253
---
**STATE.md `## Session` fields now resolve on Windows** — the session-section reader used a `\n`-only heading regex that silently failed on a CRLF `## Session` heading, nulling all session state on Windows checkouts; it now reads through the CRLF-safe section seam. (#2253)
