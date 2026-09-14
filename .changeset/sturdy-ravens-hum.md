---
type: Fixed
pr: 4719
---
**`verify references` no longer mishandles `:LINE` citations** — backtick citations with a line suffix (e.g. `src/foo.ts:42`) are now checked instead of silently dropped, and @-citations with a line suffix resolve against the underlying file instead of being reported missing (#4678).
