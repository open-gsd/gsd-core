---
type: Fixed
pr: 4537
---
**Fixed an intermittent commit-hook failure (SIGPIPE race)** — `gsd-validate-commit.sh`'s subject/config extraction used `echo|head -1`-style pipes under `set -euo pipefail`; a real (multi-line) commit message or configured commit-type list could occasionally trip a SIGPIPE that aborted the whole hook instead of the intended pass/reject, appearing as a spurious `git commit` failure. Replaced with pure bash parameter expansion, eliminating the race entirely.
