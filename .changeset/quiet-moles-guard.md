---
type: Security
pr: 5129
---
**The secret-read guard blocks a secret file bundled behind other short flags** — `grep -if.env` was allowed because only the first flag letter was stripped, so the operand was seen as `f.env`. Every tail of a single-dash word is now classified with the same secret-name check, and `.env.example` / `.envrc` stay allowed. (#5046)
