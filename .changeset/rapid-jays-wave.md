---
type: Fixed
pr: 1663
---
**`phase complete` no longer duplicates a By-Phase row when the phase number's padding differs** — completing a phase by its unpadded number (e.g. `phase complete 5`) against an existing zero-padded By-Phase row (`| 05 |`) appended a second `| 5 |` row instead of updating it, double-counting the phase in any column sum. The row matcher now canonicalizes a numeric phase to its integer form (matching `5`, `05`, `005` in either direction), so the existing row is upserted regardless of padding.
