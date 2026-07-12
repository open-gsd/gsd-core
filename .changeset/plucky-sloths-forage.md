---
type: Fixed
pr: 2224
---
**`state update-progress` no longer mangles the frontmatter and discards the progress suffix** — its Progress: regex matched the raw STATE.md including frontmatter, so the YAML `progress:` key was hit first (corrupting the frontmatter) while the body line stayed stale and was silently reverted on the next write, and any descriptive suffix after the progress bar was destroyed. It now targets the body line only and preserves the suffix. (#2177)
