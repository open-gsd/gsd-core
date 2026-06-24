---
type: Fixed
pr: 1662
---
**`phase complete` now updates the By-Phase table on CRLF (Windows) STATE.md files** — the By-Phase table matcher required bare `\n` line endings, so a STATE.md written or hand-edited with CRLF (`\r\n`) was treated as having no table: the completed phase's row was never upserted (and, with the velocity-from-table derivation, the total went stale). The matcher is now CRLF-tolerant (`\r?\n`) on the header/separator/lookahead, so CRLF STATE.md files are handled identically to LF.
