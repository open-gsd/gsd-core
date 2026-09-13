---
type: Fixed
pr: 4530
---
**Frontmatter writes no longer loosen YAML block sequences** — Markdown normalization now leaves leading frontmatter spacing intact when commands such as `frontmatter set` update an unrelated field, while body lists retain their existing normalization. (#4499)
