---
type: Fixed
pr: 2233
---
**Custom STATE.md frontmatter keys are no longer dropped on every mutating verb** — syncStateFrontmatter rebuilt the frontmatter from a fixed schema, silently dropping any custom key. It now carries forward existing keys the schema does not own. (#2202)
