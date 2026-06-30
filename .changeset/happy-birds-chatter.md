---
type: Added
pr: 1755
---
**GSD now warns when a stale global CLI (e.g. a retired @gsd-build/sdk canary) shadows your project-local install** — the gsd-tools CLI startup detects when the running binary is outside the project root while a project-local install exists, and prints a remediation warning to stderr (non-blocking). (#1754)
