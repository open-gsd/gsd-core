---
type: Fixed
pr: 6454
---
**A closed deferred item with a `### Resolution` heading is one closed item** — the deferred-items reader treated any heading followed by a deeper heading as a container, so an item written as a titled heading with body bullets and a Resolution child was reported as one open item per bullet and the audit could not be cleared; a heading whose deeper headings only record its closure is now the entry itself, closed by that resolution. (#6239)
