---
type: Fixed
pr: 6289
---
**`frontmatter set` no longer reports success for a dotted field it did not write** — `--field progress.percent` on a file with a `progress:` map used to add a separate top-level `progress.percent` key and leave the nested value unchanged. A dotted field whose prefix is an existing map is now refused (code `FRONTMATTER_DOTTED_FIELD_OVER_MAP`) and nothing is written; `frontmatter merge` refuses the same key, including over a map added by the same `--data`. Set the whole map to change a nested value.
