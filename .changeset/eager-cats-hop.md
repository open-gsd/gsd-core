---
type: Fixed
pr: 5111
---
**`milestone: null` in STATE.md no longer produces a false "asserted ... matches no ROADMAP heading" warning** — YAML null (`null`, `Null`, `NULL`, `~`, with an optional trailing comment) is now read as "no milestone asserted" by every `milestone:` reader through one shared normalizer, including `state update-progress`, which previously withheld its write on a flat ROADMAP. When the ROADMAP has real milestone sections, progress counters are withheld (left at their stored values) instead of being silently recomputed from a whole-document or on-disk scan that could conflate a foreign milestone's phases; a flat (unsectioned) ROADMAP keeps its whole-document count.
