---
type: Fixed
pr: 5355
---
**`/gsd-resume-work` no longer depends on the external `find` binary to discover checkpoints (#4805)** — agent shells that allowlist commands (an fd-only policy, for one) refused the three bare `find` calls, and their `2>/dev/null` hid the refusal, so a `.continue-here` checkpoint on disk could look absent. The step now lists checkpoints and async-job manifests with guarded shell glob loops, which need no external command and stay safe under zsh's NOMATCH.
