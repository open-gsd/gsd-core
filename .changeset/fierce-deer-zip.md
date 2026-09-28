---
type: Fixed
pr: 0
---
**`summary-extract` now fails loudly on malformed SUMMARY frontmatter** — a SUMMARY.md with unparseable YAML frontmatter used to silently report empty fields (including `requirements_completed`) at exit 0; it now exits non-zero with a parse error naming the file, and an absolute target path resolves correctly instead of being mangled by the working directory (#5013).
