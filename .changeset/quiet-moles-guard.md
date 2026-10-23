---
type: Security
pr: 5129
---
**The secret-read guard blocks a secret file bundled behind other short flags** — `grep -if.env` was allowed because only the first flag letter was stripped, so the operand was seen as `f.env`. In a single-dash word the guard now also checks the value that starts right after the run of option characters (`-if.env` and `-2nif.env` hold `.env`, `-nf=.env` holds `.env` after the `=`), with the same secret-name check, so `.env.example` / `.envrc` stay allowed. The word is checked a fixed number of times whatever its length, so a long word cannot slow the guard down. Consequences toward blocking, covered by tests: a secret-named *value* of a non-file option is now denied (`git commit -am.env`, `head -n1.env`), while `git log -S.env` was already denied on base. A shell glob or substitution inside a cluster (`-if.env*`, `-if.en?`, `-if$(echo .env)`, `-if{.env,x}`) stays allowed exactly as its unbundled form already was. (#5046)
