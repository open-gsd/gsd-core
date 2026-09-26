---
type: Fixed
pr: 4819
---
**`findProjectRoot` no longer mis-resolves through a symlinked `.planning`, and `--project-dir` now reaches verification** — a `.planning` symlinked to an externally git-managed store (the documented convention for keeping planning content out of the tracked repo) no longer causes `verification.fingerprint`/`phase.complete` to fail unconditionally with "escapes the project root" / stay permanently `stale`. An explicit `--project-dir` is now honored by both `verification.fingerprint` and the staleness recompute behind `verification.status`/`phase.complete`, instead of being validated and then ignored (#4894); behavior with no flag is unchanged.
