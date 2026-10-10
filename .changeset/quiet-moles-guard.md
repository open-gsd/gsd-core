---
type: Security
pr: 5129
---
**The secret-read guard blocks a secret file bundled behind other short flags** — `grep -if.env` was allowed because only the first flag letter was stripped, so the operand was seen as `f.env`. Every `.`-starting tail of a single-dash word is now classified with the same secret-name check (linear in word length), and `.env.example` / `.envrc` stay allowed. Consequences toward blocking, covered by tests: a secret-named *value* of a non-file option is now denied (`git commit -am.env`, `head -n1.env`; `grep -f=.env` is intentionally over-broad via the `.env` tail), while `git log -S.env` was already denied on base. A shell glob or substitution inside a cluster (`-if.env*`, `-if.en?`, `-if$(echo .env)`, `-if{.env,x}`) stays allowed exactly as its unbundled form already was. (#5046)
