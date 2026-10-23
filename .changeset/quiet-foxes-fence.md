---
type: Fixed
pr: 5589
---
**`state begin-phase` now writes the live STATE.md lines, not fenced examples, and keeps the field after a U+2028** — `Current focus`, `Phase`, `Plan`, `Status` and `Last activity` were written into the first match even when it sat inside a fenced code block above the live line, and a U+2028/U+2029 inside a wrapped focus value made the next field (for example `Stopped at`) disappear. The writers now hide fenced blocks while they rewrite, and the continuation scan treats U+2028/U+2029 as the line breaks the readers already do. (#5460)
