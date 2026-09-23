---
type: Fixed
pr: 4938
---
`query verify.artifacts` / `verify artifacts` and `phase uat-passed` now exit with non-zero status (code 1) on a negative computed domain verdict (`all_passed: false` / `passed: false`), satisfying ADR-3889 §1's pass/fail exit band under both the default contract (v1) and `--exit-contract=v2`. Previously, these gate verbs reported negative verdicts only within their JSON payload while exiting with code 0, preventing callers from detecting failure via `$?`. Affirmative verdicts continue to exit 0, precondition errors (`{error: ...}`) remain unchanged, and all JSON payload structures are fully preserved on stdout.
