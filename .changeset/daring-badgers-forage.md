---
type: Fixed
pr: 1709
---
Codex reviewer now captures the review via codex's --output-last-message flag instead of redirecting stdout, so Windows process-teardown output no longer pollutes the review file and slips past the empty-output guard.
