---
type: Fixed
pr: 5349
---
**ADR parsing no longer splits a hard-wrapped list item into several entries or keeps ordered-list numbers (#5227)** — a bullet wrapped over two lines used to become two sentence-fragment decisions, and `1.` / `1)` markers were kept as text. The parser now yields one entry per top-level list item, joins wrapped and nested lines onto it, and strips bullet and ordered markers; a block with no markers still gives one entry per line.
