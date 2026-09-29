---
type: Fixed
pr: 5114
---
**`frontmatter set` and `frontmatter merge` no longer lose or corrupt frontmatter** — a single line without a space after its colon made setting one key delete every other key. Comments and blank lines next to a changed key were dropped. Multi-line values could be left unreadable, and every markdown write reformatted the frontmatter block. Writes now keep every line they don't change, keep comments (inline and nested) or refuse, and refuse, leaving the file untouched, when the frontmatter cannot be parsed or would not read back as written. (#5105)
