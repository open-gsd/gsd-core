---
type: Security
pr: 5129
---
**The secret-read guard blocks a secret file bundled behind other short flags** — `grep -if.env` was allowed because only the first flag letter was stripped, so the operand was seen as `f.env`. Every tail of a single-dash word is now classified with the same secret-name check, and `.env.example` / `.envrc` stay allowed. Two consequences, both towards blocking and both covered by tests: a secret-named *value* of an option that is not a file operand is now denied too (`git commit -am.env`, `head -n1.env`, `git log -S.env`), and a shell glob or substitution inside a cluster (`-if.env*`, `-if.en?`) stays allowed exactly as its unbundled form already was — clustering did not widen that class. (#5046)
