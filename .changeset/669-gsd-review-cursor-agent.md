---
type: Fixed
pr: 686
---
`/gsd-review --cursor` now actually invokes the Cursor agent. Detection probes the `cursor-agent` headless binary instead of the `cursor` IDE launcher, the invocation calls the single `cursor-agent` binary in print mode (not the two-token `cursor agent`, which the IDE treats as a file path), and the review prompt is passed as a file-path argument rather than piped to stdin (which `cursor-agent -p` ignores). On failure the captured stderr is surfaced instead of a silent empty result.
