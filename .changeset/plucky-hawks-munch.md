---
type: Fixed
pr: 5576
---
**`phase complete` no longer ticks a shipped milestone's checkboxes when the active milestone is unresolved** — with no STATE `milestone:` key the fallback rewrote the whole ROADMAP and flipped the first `Phase N` in document order, which could sit inside an archived `<details>` block. The fallback now stays in the region after the last closed block. (#5543)
