---
type: Added
pr: 585
---
**`/gsd-ship` PR bodies now include a TDD Audit section** — `generate_pr_body` walks the `merge-base..HEAD` commit range (merges excluded), reads each commit's `gate_status:` Git trailer (`skill` | `fallback` | `exempt`), pairs each `test:` commit with its following `feat:`/`fix:` implementation commit in a table, and counts commits without a recognized trailer as `missing`.

A single aggregate `gate_status: skill=N, fallback=N, exempt=N, missing=N` trailer is emitted as the final line of the PR body, so a GitHub squash-merge carries the per-phase TDD audit footprint into the base branch instead of losing it with the deleted PR branch.
