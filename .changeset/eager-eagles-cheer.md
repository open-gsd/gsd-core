---
type: Fixed
pr: 0
---
**gsd-verifier now resolves gsd-tools in re-verification mode** — the gsd_run resolver was defined only in the initial-mode Step 1, so re-verification fell back to a disk-wide find / that stalled the verifier; it is now a mode-independent preamble that also forbids filesystem searches. (#5004)
