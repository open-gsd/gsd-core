---
type: Fixed
pr: 6667
---
**Settings string values containing `,}` or `,]` are no longer silently corrupted on read** — the JSONC trailing-comma cleanup ran after comment stripping, where a comma inside a string is indistinguishable from a structural trailing comma, so `{"a":"x,}y"}` parsed as `{a:"x}y"}` in the installer, the shared config reader, and JSONC config edits; the cleanup now happens inside the string-aware strip pass itself. (#5989)
