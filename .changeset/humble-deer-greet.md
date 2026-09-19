---
type: Fixed
pr: 4816
---
**`findProjectRoot` no longer mis-resolves through a symlinked `.planning`** — a `.planning` symlinked to an externally git-managed store (the documented convention for keeping planning content out of the tracked repo) no longer causes `verification.fingerprint`/`phase.complete` to fail unconditionally with "escapes the project root" / stay permanently `stale`.
