---
type: Fixed
pr: 4791
---
**`phase uat-passed` and `query verify.artifacts` now exit 1 on a negative verdict** — both gate verbs previously printed `passed: false` / `all_passed: false` and still exited 0, under the default contract and `--exit-contract=v2` alike, so a caller gating on `$?` / `set -e` / `&&` could not tell a failed gate from a passed one. The JSON verdict payloads are unchanged; an affirmative verdict still exits 0; and the precondition error arms (missing plan/phase) keep their existing exit behavior.
