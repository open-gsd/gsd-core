---
type: Added
pr: 2011
---
**Third-party capability gates now actually fire via a generic `command-exit-zero` predicate.** — a capability's declared `check.predicate` gate was rendered for display but never evaluated (only built-in `check.query` gates were enforced, and the `security` capability's gate worked solely via a hard-coded `ship.md` branch). A new generic evaluator (`gsd_run check predicate`) now evaluates `check.predicate` blocks by `kind`; the first built-in kind `command-exit-zero` runs a bounded `sh -c` command at the project root and blocks the loop on non-zero exit (timeout → block, fail-closed). The `execute:wave:post`, `execute:post`, and `plan:post` gate-dispatch sites route `predicate` gates to the new evaluator automatically. (#2008)
