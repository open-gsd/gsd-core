---
type: Fixed
pr: 0
---
**`frontmatter set` / `frontmatter merge` no longer destroy `must_haves` object-lists** — changing one frontmatter field (e.g. `wave`) silently dropped every `provides:` value and collapsed `must_haves.artifacts`/`.prohibitions` from a structured `[{path, provides}]` list into a malformed inline array, because the whole frontmatter was round-tripped through a lossy parse→serialize path that flattens object-list items to scalar strings. The write now preserves the original raw text for any structurally-unchanged top-level key and regenerates only the field that actually changed, so unrelated `must_haves` blocks survive verbatim. (#1572)
