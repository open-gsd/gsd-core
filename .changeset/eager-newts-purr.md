---
type: Fixed
pr: 1009
---
**`gsd-tools` no longer throws `EAGAIN` or truncates output under heavy load** — the CLI's stdout/stderr writes now retry the transient `EAGAIN`/`EINTR` errnos and handle short writes when the output stream is a full non-blocking pipe (e.g. the parallel test runner), instead of throwing or silently dropping bytes.
